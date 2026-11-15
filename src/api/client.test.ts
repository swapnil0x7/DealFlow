import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { setupServer } from 'msw/node'
import { http, HttpResponse } from 'msw'
import { createHandlers } from '../mocks/handlers'
import { Simulation, abortableWait } from '../mocks/simulation'
import { clock, command, data, deferred } from '../test/fixtures'
import { DealApi, TransportError } from './client'
import type { MoveCommand } from './contracts'

const simulation = new Simulation({ clock, createData: data, wait: async () => {} })
const server = setupServer(...createHandlers(simulation))
const api = () => new DealApi('http://localhost')
const move = (sessionId: string, overrides: Partial<MoveCommand> = {}) => command({ sessionId, ...overrides })

beforeAll(() => server.listen({ onUnhandledFrame: 'error' }))
beforeEach(() => {
  simulation.reset()
  simulation.configure({ minSaveDelayMs: 0, maxSaveDelayMs: 0, failureRate: 0 })
})
afterEach(() => server.resetHandlers())
afterAll(() => { simulation.dispose(); server.close() })

describe('HTTP contracts through the typed client', () => {
  it('loads a consistent snapshot/cursor, saves, skips no-ops, and emits ordered changes (T02)', async () => {
    const client = api()
    const snapshot = await client.load()
    expect(snapshot).toMatchObject({ cursor: 0, owners: data().owners })
    expect(await client.move(move(snapshot.sessionId))).toMatchObject({ status: 'succeeded', receipt: { record: { version: 2 } } })
    expect(await client.move(move(snapshot.sessionId, { mutationId: 'noop', expectedVersion: 2 }))).toMatchObject({ status: 'skipped' })
    expect(await client.changes(0)).toMatchObject({ changes: [{ sequence: 1, mutationId: 'mutation-1' }], nextCursor: 1 })
  })

  it('does not mutate for invalid stage/version/actor inputs (T02)', async () => {
    const client = api()
    const { sessionId } = await client.load()
    await expect(client.move({ ...move(sessionId), stage: 'invalid' } as unknown as MoveCommand)).rejects.toMatchObject({ issue: { code: 'invalid_request' } })
    expect((await client.load()).cursor).toBe(0)
  })

  it('supports forced pre-commit failure and retry without changing command identity (T03)', async () => {
    const client = api()
    const { sessionId } = await client.load()
    simulation.forceFault('save-failure')
    expect(await client.move(move(sessionId))).toMatchObject({ status: 'failed', error: { retryable: true } })
    expect(await client.operation('mutation-1')).toEqual({ status: 'retryable' })
    expect(await client.move(move(sessionId))).toMatchObject({ status: 'succeeded' })
    expect((await client.load()).deals[0].version).toBe(2)
  })

  it('allows exactly one of two clients saving the same version to succeed (T04)', async () => {
    const first = api()
    const second = api()
    const snapshot = await first.load()
    await second.load()
    const results = await Promise.all([
      first.move(move(snapshot.sessionId)),
      second.move(move(snapshot.sessionId, { actorId: 'owner-2', mutationId: 'other', stage: 'won' })),
    ])
    expect(results.map((result) => result.status).sort()).toEqual(['conflicted', 'succeeded'])
    expect((await first.load()).cursor).toBe(1)
  })

  it('reconciles a lost response even with change delivery unavailable, without a second commit (T06)', async () => {
    const client = api()
    const { sessionId } = await client.load()
    simulation.forceFault('lost-response')
    await expect(client.move(move(sessionId))).rejects.toBeInstanceOf(TransportError)
    simulation.configure({ offline: true })
    await expect(client.changes(0)).rejects.toBeInstanceOf(TransportError)
    await expect(client.operation('mutation-1')).rejects.toBeInstanceOf(TransportError)
    simulation.configure({ offline: false })
    const outcome = await client.operation('mutation-1')
    expect(outcome).toMatchObject({ status: 'completed', result: { status: 'succeeded' } })
    expect(await client.move(move(sessionId))).toEqual(outcome.status === 'completed' ? outcome.result : null)
    expect((await client.load()).cursor).toBe(1)
  })

  it('deduplicates requests and rejects mutation ID payload reuse (T07)', async () => {
    const client = api()
    const { sessionId } = await client.load()
    const results = await Promise.all([client.move(move(sessionId)), client.move(move(sessionId))])
    expect(results[0]).toEqual(results[1])
    await expect(client.move(move(sessionId, { stage: 'lost' }))).rejects.toMatchObject({ issue: { code: 'mutation_reused' } })
    expect((await client.load()).cursor).toBe(1)
  })

  it('returns one attributable outcome per item for mixed bulk results (T11 foundation)', async () => {
    const client = api()
    const { sessionId } = await client.load()
    simulation.forceFault('save-failure')
    const result = await client.bulk([move(sessionId), move(sessionId, { dealId: 'deal-2', mutationId: 'm2' })])
    expect(result.results).toHaveLength(2)
    expect(result.results.map((item) => item.mutationId)).toEqual(['mutation-1', 'm2'])
    expect(result.results.map((item) => item.result.status)).toEqual(['failed', 'succeeded'])
  })

  it('rejects malformed/oversized/duplicate batches before any writes', async () => {
    const client = api()
    const { sessionId } = await client.load()
    await expect(client.bulk([])).rejects.toMatchObject({ issue: { code: 'invalid_request' } })
    await expect(client.bulk([move(sessionId), move(sessionId)])).rejects.toMatchObject({ issue: { code: 'invalid_request' } })
    await expect(client.bulk([move(sessionId), move(sessionId, { dealId: 'missing', mutationId: 'missing' })])).rejects.toMatchObject({ issue: { code: 'not_found' } })
    await expect(client.bulk(Array.from({ length: 201 }, () => move(sessionId)))).rejects.toMatchObject({ issue: { code: 'invalid_request' } })
    expect((await client.load()).cursor).toBe(0)
  })

  it('distinguishes request-wide lost response from per-item results and reconciles all items', async () => {
    const client = api()
    const { sessionId } = await client.load()
    simulation.forceFault('lost-response')
    await expect(client.bulk([move(sessionId), move(sessionId, { dealId: 'deal-2', mutationId: 'm2' })])).rejects.toBeInstanceOf(TransportError)
    expect(await client.operation('mutation-1')).toMatchObject({ status: 'completed' })
    expect(await client.operation('m2')).toMatchObject({ status: 'completed' })
    expect((await client.load()).cursor).toBe(2)
  })

  it('can recover an initial read failure (T19 foundation)', async () => {
    const client = api()
    simulation.forceFault('read-failure')
    await expect(client.load()).rejects.toMatchObject({ issue: { retryable: true } })
    expect((await client.load()).deals).toHaveLength(2)
  })

  it('rejects commands and responses from a previous session (T20 foundation)', async () => {
    const client = api()
    const { sessionId } = await client.load()
    await client.reset()
    await expect(client.move(move(sessionId))).rejects.toMatchObject({ issue: { code: 'session_expired' } })
    expect((await client.load()).sessionId).not.toBe(sessionId)
  })

  it('resyncs within the same client generation so an outstanding valid write response remains usable', async () => {
    const client = api()
    const { sessionId } = await client.load()
    const started = deferred()
    const release = deferred()
    server.use(http.patch('http://localhost/api/deals/:id', async () => {
      const result = await simulation.move(move(sessionId))
      started.resolve()
      await release.promise
      return HttpResponse.json(result)
    }))
    const pending = client.move(move(sessionId))
    await started.promise
    expect((await client.resync()).deals[0]).toMatchObject({ version: 2 })
    release.resolve()
    await expect(pending).resolves.toMatchObject({ status: 'succeeded' })
  })

  it('guards old-session control writes and rejects a resync that belongs to a reset session', async () => {
    const client = api()
    await client.load()
    simulation.reset()
    await expect(client.configure({ teammatesEnabled: true })).rejects.toMatchObject({ issue: { code: 'session_expired' } })
    await expect(client.forceFault('lost-response')).rejects.toMatchObject({ issue: { code: 'session_expired' } })
    await expect(client.resync()).rejects.toMatchObject({ issue: { code: 'session_expired' } })
    expect(simulation.configuration().teammatesEnabled).toBe(false)
  })

  it('ignores a stale HTTP snapshot delivered after the client has reset', async () => {
    const started = deferred()
    const release = deferred()
    server.use(http.get('http://localhost/api/deals', async () => {
      const oldSnapshot = await simulation.snapshot()
      started.resolve()
      await release.promise
      return HttpResponse.json(oldSnapshot)
    }))
    const client = api()
    const pending = client.load()
    await started.promise
    await client.reset()
    release.resolve()
    await expect(pending).rejects.toMatchObject({ issue: { code: 'session_expired' } })
  })

  it('validates malformed JSON and change cursors and provides typed errors', async () => {
    const response = await fetch('http://localhost/api/deals/deal-1', { method: 'PATCH', body: '{bad-json' })
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_request' } })
    const client = api()
    await client.load()
    await expect(client.changes(-1)).rejects.toMatchObject({ issue: { code: 'invalid_request' } })
    expect(await client.operation('missing')).toEqual({ status: 'unknown' })
  })

  it('keeps a write outcome uncertain when its response body cannot be read', async () => {
    const client = api()
    const { sessionId } = await client.load()
    server.use(http.patch('http://localhost/api/deals/:id', () => new HttpResponse('{truncated-json', {
      headers: { 'Content-Type': 'application/json' },
    })))
    await expect(client.move(move(sessionId))).rejects.toBeInstanceOf(TransportError)
  })
})

describe('in-flight session isolation', () => {
  it('cancels timers and blocks an old delayed save from reaching the new session', async () => {
    const runtime = new Simulation({ clock, createData: data, wait: abortableWait })
    runtime.configure({ minSaveDelayMs: 10_000, maxSaveDelayMs: 10_000, failureRate: 0 })
    const pending = runtime.move(move(runtime.configuration().sessionId))
    const rejection = expect(pending).rejects.toMatchObject({ issue: { code: 'session_expired' } })
    runtime.reset()
    await rejection
    expect((await runtime.snapshot()).cursor).toBe(0)
    runtime.dispose()
  })

  it('rejects an old snapshot even if the injected transport cannot be cancelled', async () => {
    const gate = deferred()
    const runtime = new Simulation({ clock, createData: data, wait: () => gate.promise })
    const pending = runtime.snapshot()
    runtime.reset()
    gate.resolve()
    await expect(pending).rejects.toMatchObject({ issue: { code: 'session_expired' } })
    runtime.dispose()
  })
})
