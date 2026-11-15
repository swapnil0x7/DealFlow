import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TransportError } from '../../api/client'
import type { ChangePage, Snapshot } from '../../api/contracts'
import { DEFAULT_SETTINGS } from '../../mocks/simulation'
import { data, deal } from '../../test/fixtures'
import { ConfirmedReadModel } from './read-model'
import { ChangeFeed } from './feed'

function pending<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
const emptyPage = (after = 0): ChangePage => ({ sessionId: 'session-1', changes: [], nextCursor: after, hasMore: false, resyncRequired: false })
const event = (sequence: number, version = sequence + 1) => ({ sequence, mutationId: `mutation-${sequence}`, actorId: 'owner-2', record: { ...deal, stage: 'won' as const, version } })

function setup(extra: { onResync?: (snapshot: Snapshot) => void; timeoutMs?: number } = {}) {
  const model = new ConfirmedReadModel(data().deals)
  const api = {
    changes: vi.fn(async (after: number, signal?: AbortSignal): Promise<ChangePage> => { void signal; return emptyPage(after) }),
    resync: vi.fn(async (): Promise<Snapshot> => ({ sessionId: 'session-1', ...data(), cursor: 7 })),
    simulation: vi.fn(async () => ({ ...DEFAULT_SETTINGS, seed: 42, sessionId: 'session-1' })),
  }
  const operations = { confirmChange: vi.fn(), reconcileOutstanding: vi.fn(async () => {}), expireSession: vi.fn() }
  const feed = new ChangeFeed({ api, operations, model, sessionId: 'session-1', cursor: 0, ...extra })
  return { feed, model, api, operations }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })

describe('ordered single-flight change feed', () => {
  it('coalesces repeated starts/focus notifications without overlapping the current request', async () => {
    const { feed, api } = setup()
    const gate = pending<ChangePage>()
    api.changes.mockReturnValueOnce(gate.promise)
    feed.start(); feed.start()
    await vi.advanceTimersByTimeAsync(1_000)
    feed.wake(); feed.wake()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(api.changes).toHaveBeenCalledTimes(1)
    gate.resolve(emptyPage())
    await vi.advanceTimersByTimeAsync(1)
    expect(api.changes).toHaveBeenCalledTimes(2)
    feed.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('applies complete ordered pages before advancing the cursor, confirms matching old-version receipts, and drains pages', async () => {
    const { feed, model, api, operations } = setup()
    model.apply([{ ...deal, version: 3, stage: 'lost' }])
    const seen: number[] = []
    operations.confirmChange.mockImplementation(() => { seen.push(feed.store.getState().cursor) })
    api.changes.mockResolvedValueOnce({ ...emptyPage(), changes: [event(1, 2)], nextCursor: 1, hasMore: true })
    api.changes.mockResolvedValueOnce({ ...emptyPage(), changes: [event(2, 4)], nextCursor: 2 })
    feed.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(seen).toEqual([0, 1])
    expect(model.get(deal.id)).toMatchObject({ version: 4, stage: 'won' })
    expect(feed.store.getState()).toMatchObject({ cursor: 2, received: 2, status: 'live' })
    expect(api.resync).not.toHaveBeenCalled()
    feed.dispose()
  })

  it('resyncs an expired cursor without replacing the read model or captured ID/version snapshots', async () => {
    const observed: number[] = []
    const { feed, model, api, operations } = setup({ onResync: () => observed.push(model.get(deal.id)!.version) })
    const captured = Object.freeze({ id: deal.id, version: model.get(deal.id)!.version })
    api.changes.mockResolvedValueOnce({ ...emptyPage(), resyncRequired: true })
    api.resync.mockResolvedValueOnce({ sessionId: 'session-1', owners: data().owners, deals: [{ ...deal, version: 8 }], cursor: 7 })
    feed.start()
    await vi.advanceTimersByTimeAsync(1_001)
    expect(observed).toEqual([8])
    expect(captured.version).toBe(1)
    expect(feed.store.getState()).toMatchObject({ cursor: 7, resyncs: 1 })
    expect(operations.reconcileOutstanding).toHaveBeenCalledTimes(1)
    expect(api.resync).toHaveBeenCalledTimes(1)
    feed.dispose()
  })

  it('uses a fresh snapshot on a sequence gap instead of silently skipping missing events', async () => {
    const { feed, api } = setup()
    api.changes.mockResolvedValueOnce({ ...emptyPage(), changes: [event(3)], nextCursor: 3 })
    feed.start()
    await vi.advanceTimersByTimeAsync(1_001)
    expect(api.resync).toHaveBeenCalledTimes(1)
    expect(feed.store.getState().cursor).toBe(7)
    feed.dispose()
  })

  it('pauses hidden reads, ignores a cancelled late page, then catches up from the unchanged cursor', async () => {
    const { feed, model, api } = setup()
    const gate = pending<ChangePage>()
    api.changes.mockReturnValueOnce(gate.promise)
    feed.start()
    await vi.advanceTimersByTimeAsync(1_000)
    const signal = api.changes.mock.calls[0][1]!
    feed.setVisible(false)
    expect(signal.aborted).toBe(true)
    gate.resolve({ ...emptyPage(), changes: [event(1, 99)], nextCursor: 1 })
    await vi.advanceTimersByTimeAsync(4_000)
    expect(api.changes).toHaveBeenCalledTimes(1)
    expect(model.get(deal.id)?.version).toBe(1)
    expect(feed.store.getState().cursor).toBe(0)
    api.changes.mockResolvedValueOnce({ ...emptyPage(), changes: [event(1, 2)], nextCursor: 1 })
    feed.setVisible(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(model.get(deal.id)?.version).toBe(2)
    expect(api.changes.mock.calls[1][0]).toBe(0)
    feed.dispose()
  })

  it('pauses simulated and browser offline reads, resumes on reconnect, and leaves no timers after stop/start/dispose', async () => {
    const { feed, api } = setup()
    feed.setSimulationOffline(true)
    feed.start()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(api.changes).not.toHaveBeenCalled()
    feed.setSimulationOffline(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.changes).toHaveBeenCalledTimes(1)
    feed.setNetworkOnline(false)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(api.changes).toHaveBeenCalledTimes(1)
    feed.setNetworkOnline(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.changes).toHaveBeenCalledTimes(2)
    feed.stop(); feed.start(); feed.dispose(); feed.wake()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(api.changes).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reports paused delivery without advancing the cursor, then receives the held events', async () => {
    const { feed, api } = setup()
    api.changes.mockResolvedValueOnce({ ...emptyPage(), deliveryPaused: true })
    api.changes.mockResolvedValueOnce({ ...emptyPage(), changes: [event(1)], nextCursor: 1 })
    feed.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(feed.store.getState()).toMatchObject({ status: 'paused', cursor: 0 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(feed.store.getState()).toMatchObject({ status: 'live', cursor: 1 })
    feed.dispose()
  })

  it('retains the cursor on a failed read and recovers without refetching the dataset', async () => {
    const { feed, api } = setup()
    api.changes.mockRejectedValueOnce(new TransportError('interrupted'))
    api.changes.mockResolvedValueOnce({ ...emptyPage(), changes: [event(1)], nextCursor: 1 })
    feed.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(feed.store.getState()).toMatchObject({ status: 'reconnecting', cursor: 0 })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(feed.store.getState()).toMatchObject({ status: 'live', cursor: 1 })
    expect(api.resync).not.toHaveBeenCalled()
    feed.dispose()
  })

  it('detects offline simulation after a transport error and stops polling until an explicit wake', async () => {
    const { feed, api } = setup()
    api.changes.mockRejectedValueOnce(new TransportError('offline'))
    api.simulation.mockResolvedValueOnce({ ...DEFAULT_SETTINGS, seed: 42, sessionId: 'session-1', offline: true })
    feed.start()
    await vi.advanceTimersByTimeAsync(5_000)
    expect(feed.store.getState().status).toBe('offline')
    expect(api.changes).toHaveBeenCalledTimes(1)
    feed.wake()
    await vi.advanceTimersByTimeAsync(1)
    expect(api.changes).toHaveBeenCalledTimes(2)
    feed.dispose()
  })

  it('does not advance past a failed operation-confirmation hook and safely replays the page', async () => {
    const { feed, api, operations } = setup()
    operations.confirmChange.mockImplementationOnce(() => { throw new Error('injected processing failure') })
    api.changes.mockResolvedValue({ ...emptyPage(), changes: [event(1)], nextCursor: 1 })
    feed.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(feed.store.getState().cursor).toBe(0)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(feed.store.getState().cursor).toBe(1)
    expect(operations.confirmChange).toHaveBeenCalledTimes(2)
    feed.dispose()
  })

  it('expires mismatched sessions, blocks commands, and does not silently load a new session', async () => {
    const { feed, api, operations } = setup()
    api.changes.mockResolvedValueOnce({ ...emptyPage(), sessionId: 'new-session' })
    feed.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(feed.store.getState().status).toBe('expired')
    expect(operations.expireSession).toHaveBeenCalledTimes(1)
    feed.wake()
    await vi.advanceTimersByTimeAsync(3_000)
    expect(api.changes).toHaveBeenCalledTimes(1)
    expect(api.resync).not.toHaveBeenCalled()
    feed.dispose()
  })

  it('also detects a reset session through the offline control-plane probe after a failed read', async () => {
    const { feed, api, operations } = setup()
    api.changes.mockRejectedValueOnce(new TransportError('interrupted during reset'))
    api.simulation.mockResolvedValueOnce({ ...DEFAULT_SETTINGS, seed: 42, sessionId: 'new-session', offline: true })
    feed.start()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(feed.store.getState().status).toBe('expired')
    expect(operations.expireSession).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(api.changes).toHaveBeenCalledTimes(1)
    feed.dispose()
  })

  it('ignores an old resync delivered after disposal', async () => {
    const { feed, model, api } = setup()
    const gate = pending<Snapshot>()
    api.changes.mockResolvedValueOnce({ ...emptyPage(), resyncRequired: true })
    api.resync.mockReturnValueOnce(gate.promise)
    feed.start()
    await vi.advanceTimersByTimeAsync(1_000)
    feed.dispose()
    gate.resolve({ sessionId: 'session-1', ...data(), deals: [{ ...deal, version: 99 }], cursor: 98 })
    await vi.advanceTimersByTimeAsync(1)
    expect(model.get(deal.id)?.version).toBe(1)
    expect(feed.store.getState().cursor).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('times out an unresponsive read and ignores its late reply after reconnect', async () => {
    const { feed, model, api } = setup({ timeoutMs: 50 })
    const gate = pending<ChangePage>()
    api.changes.mockReturnValueOnce(gate.promise)
    feed.start()
    await vi.advanceTimersByTimeAsync(1_050)
    expect(feed.store.getState().status).toBe('reconnecting')
    expect(api.changes.mock.calls[0][1]?.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(1_000)
    gate.resolve({ ...emptyPage(), changes: [event(1, 99)], nextCursor: 1 })
    await vi.advanceTimersByTimeAsync(1)
    expect(model.get(deal.id)?.version).toBe(1)
    expect(feed.store.getState().cursor).toBe(0)
    feed.dispose()
  })
})
