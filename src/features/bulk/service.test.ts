import { afterEach, describe, expect, it, vi } from 'vitest'
import { TransportError } from '../../api/client'
import { ApiError } from '../../api/contracts'
import type { MoveCommand } from '../../api/contracts'
import type { Deal } from '../../domain/deal'
import { DealRepository } from '../../mocks/repository'
import { clock, deal, deferred, owners } from '../../test/fixtures'
import { ConfirmedReadModel } from '../collaboration/read-model'
import { ActivityRegistry } from '../operations/activity'
import { OperationService } from '../operations/service'
import { BulkService } from './service'
import { ITEM_STATES } from './types'

const records = (count: number): Deal[] => Array.from({ length: count }, (_, i) => ({ ...deal, id: `deal-${i + 1}`, companyName: `Company ${i + 1}` }))
function setup(count = 4, options: { timeoutMs?: number; historyLimit?: number; itemLimit?: number } = {}) {
  const repository = new DealRepository({ sessionId: 'session-1', deals: records(count), owners, clock })
  const model = new ConfirmedReadModel(repository.snapshot().deals)
  const activity = new ActivityRegistry()
  const api = {
    bulk: vi.fn(async (commands: readonly MoveCommand[]) => ({ results: await Promise.all(commands.map(async (command) => ({
      mutationId: command.mutationId, dealId: command.dealId, result: await repository.move(command),
    }))) })),
    operation: vi.fn(async (id: string) => repository.operation(id, 'session-1')),
  }
  let id = 0
  const service = new BulkService({ api, model, activity, sessionId: 'session-1', actorId: 'owner-1', id: () => `bulk-${++id}`, clock, ...options })
  const submit = (target: Deal['stage'] = 'contacted') => {
    const preview = service.preview(model.all(), target, 'All deals')
    expect(service.submit(preview)).toBe(preview.id)
    return preview
  }
  const summary = (groupId: string) => service.store.getState().groups.find((group) => group.id === groupId)!
  const account = (groupId: string) => {
    const group = summary(groupId)
    expect(ITEM_STATES.reduce((sum, state) => sum + group.counts[state], 0)).toBe(group.total)
  }
  return { repository, model, activity, api, service, submit, summary, account }
}
afterEach(() => vi.useRealTimers())

describe('bounded bulk command workflow', () => {
  it('retries one failed row with its original command while leaving other failures untouched', async () => {
    const { api, repository, service, submit, summary } = setup(2)
    api.bulk.mockImplementationOnce(async (commands) => ({ results: commands.map((command) => ({ mutationId: command.mutationId, dealId: command.dealId,
      result: { status: 'failed' as const, error: { code: 'save_failed' as const, message: 'Try again', retryable: true } } })) }))
    const preview = submit()
    await vi.waitFor(() => expect(summary(preview.id).counts.failed).toBe(2))
    expect(summary(preview.id).needsAction).toBe(2)
    const id = preview.items[0].command.mutationId
    expect(service.groupForItem(id)).toBe(preview.id)
    service.retryItem(id)
    await vi.waitFor(() => expect(summary(preview.id).counts.succeeded).toBe(1))
    expect(summary(preview.id).counts.failed).toBe(1)
    expect(summary(preview.id).needsAction).toBe(1)
    expect(api.bulk.mock.calls[1][0]).toEqual([preview.items[0].command])
    expect(repository.snapshot().cursor).toBe(1)
    const undo = service.previewUndo(preview.id, id)!
    expect(undo.items).toHaveLength(1)
    expect(undo.items[0].command).toMatchObject({ dealId: preview.items[0].command.dealId, expectedVersion: 2, stage: 'new-lead' })
    service.dispose()
  })

  it('acknowledges a bulk conflict locally with accurate action counts and rejects stale reviews', async () => {
    const { repository, model, api, service, summary, account } = setup(1)
    const preview = service.preview(model.all(), 'contacted', 'All')
    await repository.move({ ...preview.items[0].command, mutationId: 'teammate', actorId: 'owner-2', stage: 'won' })
    service.submit(preview)
    await vi.waitFor(() => expect(summary(preview.id).needsAction).toBe(1))
    const id = preview.items[0].command.mutationId
    expect(service.keepLatest(id, deal)).toBe(false)
    expect(service.keepLatest(id, model.get('deal-1')!)).toBe(true)
    await vi.waitFor(() => expect(summary(preview.id).needsAction).toBe(0))
    expect(service.getItemById(id)).toMatchObject({ status: 'conflicted', keptVersion: 2 })
    expect(service.previewConflict(preview.id, id, model.get('deal-1')!)).toBeNull()
    expect(api.bulk).toHaveBeenCalledTimes(1)
    account(preview.id)
    service.dispose()
  })
  it('reviews a frozen snapshot without writes and accounts explicitly for pending and no-op records', async () => {
    const { model, activity, api, service, summary, account } = setup()
    model.apply([{ ...model.get('deal-4')!, stage: 'contacted', version: 2 }])
    activity.claim({ id: 'single', dealId: 'deal-2', kind: 'move', stage: 'won', status: 'saving' })
    const preview = service.preview(model.all(), 'contacted', 'Reviewed filter')
    expect(api.bulk).not.toHaveBeenCalled()
    expect(preview).toMatchObject({ pending: 1, noops: 1, changed: 0 })
    const command = preview.items[0].command
    model.apply([{ ...model.get('deal-1')!, stage: 'negotiation', version: 2 }])
    expect(preview.items[0].command).toBe(command)
    expect(command.expectedVersion).toBe(1)
    expect(Object.isFrozen(command)).toBe(true)
    service.submit(preview)
    expect(service.submit(preview)).toBeNull()
    await vi.waitFor(() => expect(summary(preview.id).counts.succeeded).toBe(2))
    expect(summary(preview.id).counts.skipped).toBe(2)
    expect(api.bulk.mock.calls[0][0].map((item) => item.dealId)).toEqual(['deal-1', 'deal-3'])
    account(preview.id)
    service.dispose()
  })

  it('batches off-screen items by 200, keeps at most four requests in flight, and guards queued deals from single edits', async () => {
    const { model, activity, api, repository, service, submit, summary, account } = setup(1_201)
    const gates: ReturnType<typeof deferred>[] = []
    let running = 0
    let peak = 0
    api.bulk.mockImplementation(async (commands) => {
      running++; peak = Math.max(peak, running)
      const gate = deferred(); gates.push(gate); await gate.promise
      const results = await Promise.all(commands.map(async (command) => ({ mutationId: command.mutationId, dealId: command.dealId, result: await repository.move(command) })))
      running--
      return { results }
    })
    const preview = submit()
    const single = new OperationService({ api: { move: (command) => repository.move(command), operation: api.operation }, model, activity, sessionId: 'session-1', actorId: 'owner-1' })
    await vi.waitFor(() => expect(api.bulk).toHaveBeenCalledTimes(4))
    expect(api.bulk.mock.calls.every(([commands]) => commands.length === 200)).toBe(true)
    expect(single.move(model.get('deal-1201')!, 'won')).toBeNull()
    expect(model.get('deal-1')?.stage).toBe('new-lead')
    gates.forEach((gate) => gate.resolve())
    await vi.waitFor(() => expect(api.bulk).toHaveBeenCalledTimes(7))
    gates.forEach((gate) => gate.resolve())
    await vi.waitFor(() => expect(summary(preview.id).counts.succeeded).toBe(1_201))
    expect(peak).toBe(4)
    const sent = api.bulk.mock.calls.flatMap(([commands]) => commands)
    expect(new Set(sent.map((command) => command.dealId)).size).toBe(1_201)
    expect(sent.map((command) => command.mutationId)).toEqual(preview.items.map((item) => item.command.mutationId))
    expect(repository.snapshot().cursor).toBe(1_201)
    account(preview.id)
    single.dispose(); service.dispose()
  })

  it('preserves mixed results, retries failures only with original commands, and explicitly reviews captured conflict versions', async () => {
    const { repository, model, api, service, summary, account } = setup()
    await repository.move({ sessionId: 'session-1', actorId: 'owner-2', mutationId: 'noop', dealId: 'deal-4', expectedVersion: 1, stage: 'contacted' })
    model.apply([repository.record('deal-4')])
    await repository.move({ sessionId: 'session-1', actorId: 'owner-2', mutationId: 'teammate', dealId: 'deal-3', expectedVersion: 1, stage: 'won' })
    let fail = true
    api.bulk.mockImplementation(async (commands) => ({ results: await Promise.all(commands.map(async (command) => ({ mutationId: command.mutationId, dealId: command.dealId,
      result: await repository.move(command, async () => { if (command.dealId === 'deal-2' && fail) throw new ApiError('save_failed', 'Try again', true) }),
    }))) }))
    const preview = service.preview(model.all(), 'contacted', 'All deals')
    service.submit(preview)
    await vi.waitFor(() => expect(summary(preview.id).counts).toEqual({ queued: 0, saving: 0, succeeded: 1, failed: 1, conflicted: 1, unconfirmed: 0, skipped: 1 }))
    const originalSuccess = service.getItem(preview.id, preview.items[0].command.mutationId)
    fail = false
    service.retryFailed(preview.id)
    await vi.waitFor(() => expect(summary(preview.id).counts.succeeded).toBe(2))
    expect(api.bulk.mock.calls[1][0]).toEqual([preview.items[1].command])
    expect(service.getItem(preview.id, preview.items[0].command.mutationId)).toBe(originalSuccess)
    const retried = service.getItem(preview.id, preview.items[1].command.mutationId)!
    expect(retried.history.map((attempt) => attempt.status)).toEqual(['failed', 'succeeded'])
    const reviewed = model.get('deal-3')!
    const replacement = service.previewConflict(preview.id, preview.items[2].command.mutationId, reviewed)!
    await repository.move({ ...preview.items[2].command, mutationId: 'newer', actorId: 'owner-2', stage: 'lost', expectedVersion: 2 })
    service.submit(replacement)
    await vi.waitFor(() => expect(summary(replacement.id).counts.conflicted).toBe(1))
    expect(replacement.items[0].command.expectedVersion).toBe(2)
    expect(service.getItem(preview.id, preview.items[2].command.mutationId)?.status).toBe('conflicted')
    expect(service.previewConflict(preview.id, preview.items[2].command.mutationId, model.get('deal-3')!)).toBeNull()
    account(preview.id); account(replacement.id)
    service.dispose()
  })

  it('shares the four-request ceiling across independently submitted operations', async () => {
    const { model, api, service, summary, account } = setup(1_602)
    const original = api.bulk.getMockImplementation()!
    let running = 0
    let peak = 0
    api.bulk.mockImplementation(async (commands) => {
      running++; peak = Math.max(peak, running)
      await new Promise((resolve) => setTimeout(resolve, 25))
      const result = await original(commands)
      running--
      return result
    })
    const first = service.preview(model.all().slice(0, 801), 'contacted', 'First set')
    const second = service.preview(model.all().slice(801), 'won', 'Second set')
    service.submit(first); service.submit(second)
    await vi.waitFor(() => {
      expect(summary(first.id).counts.succeeded).toBe(801)
      expect(summary(second.id).counts.succeeded).toBe(801)
    })
    expect(peak).toBe(4)
    expect(api.bulk).toHaveBeenCalledTimes(10)
    expect(new Set(api.bulk.mock.calls.flatMap(([commands]) => commands.map((command) => command.dealId))).size).toBe(1_602)
    account(first.id); account(second.id)
    service.dispose()
  })

  it('retains successful moves while partial Undo conflicts and failures recover separately', async () => {
    const { repository, model, api, service, submit, summary, account } = setup(3)
    const original = submit()
    await vi.waitFor(() => expect(summary(original.id).counts.succeeded).toBe(3))
    await repository.move({ ...original.items[0].command, mutationId: 'remote', actorId: 'owner-2', stage: 'won', expectedVersion: 2 })
    let fail = true
    api.bulk.mockImplementation(async (commands) => ({ results: await Promise.all(commands.map(async (command) => ({ mutationId: command.mutationId, dealId: command.dealId,
      result: await repository.move(command, async () => { if (command.dealId === 'deal-2' && fail) throw new ApiError('save_failed', 'Undo interrupted', true) }),
    }))) }))
    const undo = service.previewUndo(original.id)!
    expect(undo.items.every((item) => item.command.expectedVersion === 2 && item.command.stage === 'new-lead')).toBe(true)
    service.submit(undo)
    await vi.waitFor(() => expect(summary(undo.id).counts).toMatchObject({ succeeded: 1, conflicted: 1, failed: 1 }))
    fail = false
    service.retryFailed(undo.id)
    await vi.waitFor(() => expect(summary(undo.id).counts.succeeded).toBe(2))
    expect(api.bulk.mock.calls[2][0]).toEqual([undo.items[1].command])
    expect(summary(original.id).counts.succeeded).toBe(3)
    expect(model.get('deal-1')).toMatchObject({ stage: 'won', version: 3 })
    expect(model.get('deal-2')).toMatchObject({ stage: 'new-lead', version: 3, lastActivityAt: null })
    expect(service.previewUndo(original.id)).toBeNull()
    expect(service.previewUndo(undo.id)).toBeNull()
    account(original.id); account(undo.id)
    service.dispose()
  })

  it('distinguishes a whole-request lost response, checks receipts without resending, and preserves newer model data', async () => {
    const { repository, model, api, service, submit, summary, account } = setup(2)
    api.bulk.mockImplementationOnce(async (commands) => {
      await Promise.all(commands.map((command) => repository.move(command)))
      throw new TransportError('response lost after commit')
    })
    const preview = submit()
    await vi.waitFor(() => expect(summary(preview.id).counts.unconfirmed).toBe(2))
    expect(model.get('deal-1')?.version).toBe(1)
    expect(service.canDismiss(preview.id)).toBe(false)
    api.operation.mockRejectedValueOnce(new TransportError('reads unavailable'))
    await service.reconcile(preview.id)
    expect(summary(preview.id).counts).toMatchObject({ unconfirmed: 1, succeeded: 1 })
    model.apply([{ ...model.get('deal-1')!, version: 3, stage: 'won' }])
    await service.reconcile(preview.id)
    expect(summary(preview.id).counts.succeeded).toBe(2)
    expect(api.bulk).toHaveBeenCalledTimes(1)
    expect(repository.snapshot().cursor).toBe(2)
    expect(model.get('deal-1')).toMatchObject({ version: 3, stage: 'won' })
    expect(service.undoEligible(preview.id)).toBe(1)
    account(preview.id)
    service.dispose()
  })

  it('serializes concurrent row and group receipt checks within the global four-read bound', async () => {
    const { repository, api, service, submit, summary } = setup(8)
    api.bulk.mockImplementationOnce(async (commands) => {
      await Promise.all(commands.map((command) => repository.move(command)))
      throw new TransportError('Lost after commit')
    })
    const preview = submit()
    await vi.waitFor(() => expect(summary(preview.id).counts.unconfirmed).toBe(8))
    let running = 0
    let peak = 0
    api.operation.mockImplementation(async (id) => {
      running++
      peak = Math.max(peak, running)
      try { await new Promise((resolve) => setTimeout(resolve, 2)); return await repository.operation(id, 'session-1') }
      finally { running-- }
    })
    await Promise.all([
      service.reconcileItem(preview.items[0].command.mutationId),
      service.reconcile(preview.id),
      service.reconcileItem(preview.items[7].command.mutationId),
      service.reconcile(preview.id),
    ])
    expect(peak).toBeLessThanOrEqual(4)
    expect(api.operation).toHaveBeenCalledTimes(8)
    expect(api.bulk).toHaveBeenCalledTimes(1)
    expect(summary(preview.id).counts.succeeded).toBe(8)
    service.dispose()
  })

  it('retries unknown outcomes only after explicit receipt checks, keeping mutation IDs and version guards', async () => {
    const { repository, api, service, submit, summary } = setup(2)
    api.bulk.mockRejectedValueOnce(new TransportError('request did not arrive'))
    const preview = submit()
    await vi.waitFor(() => expect(summary(preview.id).counts.unconfirmed).toBe(2))
    service.retryChecked(preview.id)
    expect(api.bulk).toHaveBeenCalledTimes(1)
    await service.reconcile(preview.id)
    expect(service.page(preview.id, 'unconfirmed', 0).every((item) => item.canResume)).toBe(true)
    await repository.move({ ...preview.items[0].command, mutationId: 'other', actorId: 'owner-2', stage: 'won' })
    service.retryChecked(preview.id)
    await vi.waitFor(() => expect(summary(preview.id).counts).toMatchObject({ succeeded: 1, conflicted: 1, unconfirmed: 0 }))
    expect(api.bulk.mock.calls[1][0]).toEqual(api.bulk.mock.calls[0][0])
    expect(api.bulk.mock.calls[1][0][0].expectedVersion).toBe(1)
    service.dispose()
  })

  it('stops new launches offline and requires explicit resume after reconnect, retaining earlier successes', async () => {
    const { api, service, submit, summary, account } = setup(1_001)
    const original = api.bulk.getMockImplementation()!
    const gates: ReturnType<typeof deferred>[] = []
    api.bulk.mockImplementation(async (commands) => { const gate = deferred(); gates.push(gate); await gate.promise; return original(commands) })
    const preview = submit()
    await vi.waitFor(() => expect(api.bulk).toHaveBeenCalledTimes(4))
    service.setOnline(false)
    gates.forEach((gate) => gate.resolve())
    await vi.waitFor(() => expect(summary(preview.id).counts.succeeded).toBe(800))
    expect(summary(preview.id).counts.queued).toBe(201)
    service.setOnline(true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(api.bulk).toHaveBeenCalledTimes(4)
    service.resume(preview.id)
    await vi.waitFor(() => expect(api.bulk).toHaveBeenCalledTimes(6))
    gates.forEach((gate) => gate.resolve())
    await vi.waitFor(() => expect(summary(preview.id).counts.succeeded).toBe(1_001))
    account(preview.id)
    service.dispose()
  })

  it('accepts feed confirmation before a late HTTP failure without downgrading or overwriting newer versions', async () => {
    const { api, model, service, submit, summary } = setup(1)
    const gate = deferred()
    api.bulk.mockImplementationOnce(async () => { await gate.promise; throw new TransportError('late error') })
    const preview = submit()
    await vi.waitFor(() => expect(api.bulk).toHaveBeenCalledTimes(1))
    model.apply([{ ...deal, version: 3, stage: 'won' }])
    service.confirmChange({ sequence: 1, mutationId: preview.items[0].command.mutationId, actorId: 'owner-1', record: { ...deal, version: 2, stage: 'contacted' } })
    gate.resolve()
    await vi.waitFor(() => expect(summary(preview.id).counts.succeeded).toBe(1))
    expect(model.get(deal.id)).toMatchObject({ version: 3, stage: 'won' })
    expect(service.previewUndo(preview.id)).toBeNull()
    service.dispose()
  })

  it('does not free physical concurrency slots on timeout, and retains late successful results while the queue stays paused', async () => {
    vi.useFakeTimers()
    const { api, repository, service, submit, summary } = setup(1_001, { timeoutMs: 10 })
    const gates: ReturnType<typeof deferred>[] = []
    api.bulk.mockImplementation(async (commands) => {
      const gate = deferred(); gates.push(gate)
      return { results: await Promise.all(commands.map(async (command) => ({ mutationId: command.mutationId, dealId: command.dealId,
        result: await repository.move(command, () => gate.promise),
      }))) }
    })
    const preview = submit()
    await vi.advanceTimersByTimeAsync(100)
    expect(api.bulk).toHaveBeenCalledTimes(4)
    expect(summary(preview.id).counts).toMatchObject({ unconfirmed: 800, queued: 201 })
    await service.reconcile(preview.id)
    expect(service.page(preview.id, 'unconfirmed', 0, 1_001).every((item) => !item.canResume && !item.checking)).toBe(true)
    expect(service.previewUndo(preview.id)).toBeNull()
    expect(service.canDismiss(preview.id)).toBe(false)
    service.resume(preview.id)
    await vi.advanceTimersByTimeAsync(100)
    expect(api.bulk).toHaveBeenCalledTimes(4)
    service.setOnline(false)
    gates.forEach((gate) => gate.resolve())
    await vi.advanceTimersByTimeAsync(100)
    expect(summary(preview.id).counts.succeeded).toBe(800)
    expect(api.bulk).toHaveBeenCalledTimes(4)
    service.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('treats incomplete batch responses as uncertainty and recovers through the original receipts', async () => {
    const { api, service, submit, summary } = setup(2)
    const original = api.bulk.getMockImplementation()!
    api.bulk.mockImplementationOnce(async (commands) => ({ results: (await original(commands)).results.slice(0, 1) }))
    const preview = submit()
    await vi.waitFor(() => expect(summary(preview.id).counts.unconfirmed).toBe(2))
    await service.reconcileOutstanding()
    expect(summary(preview.id).counts.succeeded).toBe(2)
    expect(api.bulk).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('rejects a mismatched receipt instead of claiming success or leaving an item saving forever', async () => {
    const { api, service, submit, summary } = setup(1)
    const original = api.bulk.getMockImplementation()!
    api.bulk.mockImplementationOnce(async (commands) => {
      const response = await original(commands)
      const result = response.results[0].result
      if (result.status === 'succeeded') result.receipt = { ...result.receipt, actorId: 'owner-2' }
      return response
    })
    const preview = submit()
    await vi.waitFor(() => expect(summary(preview.id).counts).toMatchObject({ unconfirmed: 1, saving: 0, succeeded: 0 }))
    await service.reconcile(preview.id)
    expect(summary(preview.id).counts.succeeded).toBe(1)
    expect(api.bulk).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('rechecks pending ownership on confirmation and does not retry permanent failures', async () => {
    const { api, model, activity, service, summary } = setup(2)
    const preview = service.preview(model.all(), 'contacted', 'All')
    activity.claim({ id: 'single-after-review', dealId: 'deal-2', stage: 'won', kind: 'move', status: 'saving' })
    api.bulk.mockResolvedValueOnce({ results: [{ mutationId: preview.items[0].command.mutationId, dealId: 'deal-1',
      result: { status: 'failed', error: { code: 'history_full', message: 'The receipt ledger is full.', retryable: false } } }] })
    service.submit(preview)
    await vi.waitFor(() => expect(summary(preview.id).counts).toMatchObject({ failed: 1, skipped: 1 }))
    expect(service.getItem(preview.id, preview.items[1].command.mutationId)?.skipKind).toBe('pending')
    service.retryFailed(preview.id)
    expect(summary(preview.id).retryable).toBe(0)
    expect(api.bulk).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('bounds history without automatic eviction and protects unresolved parent/child results', async () => {
    const { model, api, service, submit, summary } = setup(2, { historyLimit: 2, itemLimit: 4 })
    const preview = submit()
    await vi.waitFor(() => expect(summary(preview.id).counts.succeeded).toBe(2))
    const undo = service.previewUndo(preview.id)!
    const gate = deferred()
    const original = api.bulk.getMockImplementation()!
    api.bulk.mockImplementationOnce(async (commands) => { await gate.promise; return original(commands) })
    service.submit(undo)
    expect(service.canDismiss(preview.id)).toBe(false)
    expect(service.submit(service.preview(model.all(), 'won', 'All'))).toBeNull()
    expect(service.store.getState().notice).toContain('history is full')
    gate.resolve()
    await vi.waitFor(() => expect(summary(undo.id).counts.succeeded).toBe(2))
    service.dismiss(preview.id)
    expect(service.store.getState().groups.map((group) => group.id)).toEqual([undo.id])
    expect(service.submit(service.preview(model.all(), 'won', 'All'))).not.toBeNull()
    service.dispose()
  })

  it('invalidates old callbacks on disposal and marks never-launched versus uncertain work honestly on expiry', async () => {
    vi.useFakeTimers()
    const { model, api, activity, service, submit, summary } = setup(1_001)
    const gate = deferred()
    const original = api.bulk.getMockImplementation()!
    api.bulk.mockImplementation(async (commands) => { await gate.promise; return original(commands) })
    const preview = submit()
    await vi.advanceTimersByTimeAsync(5)
    service.expireSession()
    expect(summary(preview.id).counts).toMatchObject({ unconfirmed: 800, skipped: 201 })
    expect(service.submit(service.preview(model.all(), 'won', 'All'))).toBeNull()
    service.dispose()
    expect(vi.getTimerCount()).toBe(0)
    expect(activity.isBlocked('deal-1')).toBe(false)
    gate.resolve()
    await vi.advanceTimersByTimeAsync(10)
    expect(model.get('deal-1')?.version).toBe(1)
  })
})
