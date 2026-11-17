import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/contracts'
import { clock, command, data, deferred } from '../test/fixtures'
import { DealRepository } from './repository'

const createRepository = (options = {}) =>
  new DealRepository({ sessionId: 'session-1', ...data(), clock, ...options })

describe('authoritative repository', () => {
  it('isolates input records and every returned snapshot, receipt, event, and operation result', async () => {
    const input = data()
    const repository = new DealRepository({ ...input, sessionId: 'session-1', clock })
    input.deals[0] = { ...input.deals[0], version: 99 }
    const snapshot = repository.snapshot()
    snapshot.deals[0] = { ...snapshot.deals[0], version: 100 }
    const result = await repository.move(command())
    if (result.status !== 'succeeded') throw new Error('Expected success')
    Object.assign(result.receipt.record, { version: 200 })
    const page = repository.changePage(0, 'session-1')
    Object.assign(page.changes[0].record, { version: 300 })
    const status = repository.operation('mutation-1', 'session-1')
    if (status.status === 'completed' && status.result.status === 'succeeded')
      Object.assign(status.result.receipt.record, { version: 400 })
    expect(repository.snapshot().deals[0].version).toBe(2)
    expect(await repository.move(command())).toMatchObject({ receipt: { record: { version: 2 } } })
  })

  it('commits once, preserves activity, and reports a no-op without incrementing the version (T02)', async () => {
    const repository = createRepository()
    expect(await repository.move(command())).toMatchObject({
      status: 'succeeded',
      receipt: {
        changed: true,
        previousStage: 'new-lead',
        record: { version: 2, lastActivityAt: null, updatedAt: new Date(clock()).toISOString() },
      },
    })
    expect(
      await repository.move(command({ expectedVersion: 2, mutationId: 'noop' })),
    ).toMatchObject({ status: 'skipped', receipt: { changed: false, record: { version: 2 } } })
    expect(repository.changePage(0, 'session-1').changes).toHaveLength(1)
  })

  it.each([
    { stage: 'invalid' },
    { expectedVersion: 0 },
    { expectedVersion: 1.5 },
    { mutationId: '' },
    { actorId: 'missing' },
    { dealId: 'missing' },
    { sessionId: 'old' },
  ])('rejects invalid commands without mutation: %j', async (input) => {
    const repository = createRepository()
    await expect(repository.move({ ...command(), ...input })).rejects.toBeInstanceOf(ApiError)
    expect(repository.snapshot().cursor).toBe(0)
  })

  it('makes a pre-commit failure retryable with the same command and protects its payload (T03)', async () => {
    const repository = createRepository()
    const failure = async () => {
      throw new ApiError('save_failed', 'Forced failure', true)
    }
    expect(await repository.move(command(), failure)).toMatchObject({ status: 'failed' })
    expect(repository.snapshot().deals[0].version).toBe(1)
    expect(repository.operation('mutation-1', 'session-1')).toEqual({ status: 'retryable' })
    await expect(repository.move(command({ stage: 'won' }))).rejects.toMatchObject({
      issue: { code: 'mutation_reused' },
    })
    expect(await repository.move(command())).toMatchObject({ status: 'succeeded' })
  })

  it('checks the current version after the delay, so two clients cannot both win (T04)', async () => {
    const repository = createRepository()
    const gate = deferred()
    const slow = repository.move(command(), () => gate.promise)
    const fast = await repository.move(
      command({ actorId: 'owner-2', mutationId: 'other', stage: 'won' }),
    )
    gate.resolve()
    expect(fast.status).toBe('succeeded')
    expect(await slow).toMatchObject({ status: 'conflicted', latest: { version: 2, stage: 'won' } })
    expect(repository.snapshot().cursor).toBe(1)
  })

  it('deduplicates in-flight and completed writes and rejects changed payloads (T07)', async () => {
    const repository = createRepository()
    const gate = deferred()
    const delay = vi.fn(() => gate.promise)
    const first = repository.move(command(), delay)
    const duplicate = repository.move(command(), delay)
    expect(repository.operation('mutation-1', 'session-1')).toEqual({ status: 'pending' })
    await expect(repository.move(command({ stage: 'lost' }))).rejects.toMatchObject({
      issue: { code: 'mutation_reused' },
    })
    gate.resolve()
    expect(await first).toEqual(await duplicate)
    expect(await repository.move(command())).toEqual(await first)
    expect(delay).toHaveBeenCalledTimes(1)
    expect(repository.snapshot().cursor).toBe(1)
  })

  it('clears in-flight state even when an injected pre-commit hook throws synchronously', async () => {
    const repository = createRepository()
    expect(
      await repository.move(command(), () => {
        throw new ApiError('save_failed', 'Failed', true)
      }),
    ).toMatchObject({ status: 'failed' })
    expect(repository.operation('mutation-1', 'session-1')).toEqual({ status: 'retryable' })
    expect(await repository.move(command())).toMatchObject({ status: 'succeeded' })
  })

  it('keeps receipts available at capacity instead of evicting recoverable writes', async () => {
    const repository = createRepository({ maxMutations: 1 })
    const first = await repository.move(command())
    await expect(
      repository.move(command({ mutationId: 'new', dealId: 'deal-2' })),
    ).rejects.toMatchObject({ issue: { code: 'history_full' } })
    expect(await repository.move(command())).toEqual(first)
    expect(repository.operation('mutation-1', 'session-1').status).toBe('completed')
  })

  it('paginates changes and reports an expired cursor without hiding missing events (T21 foundation)', async () => {
    const repository = createRepository({ maxChanges: 2 })
    for (let version = 1; version <= 3; version++) {
      await repository.move(
        command({
          expectedVersion: version,
          mutationId: `m-${version}`,
          stage: version % 2 ? 'won' : 'lost',
        }),
      )
    }
    expect(repository.changePage(0, 'session-1')).toMatchObject({
      changes: [],
      resyncRequired: true,
    })
    expect(repository.changePage(1, 'session-1', 1)).toMatchObject({
      changes: [{ sequence: 2 }],
      nextCursor: 2,
      hasMore: true,
    })
    expect(repository.changePage(2, 'session-1')).toMatchObject({
      changes: [{ sequence: 3 }],
      nextCursor: 3,
      hasMore: false,
    })
    expect(repository.snapshot().cursor).toBe(3)
  })

  it('invalidates delayed writes when their session is disposed (T20 foundation)', async () => {
    const repository = createRepository()
    const gate = deferred()
    const pending = repository.move(command(), () => gate.promise)
    repository.invalidate()
    gate.resolve()
    await expect(pending).rejects.toMatchObject({ issue: { code: 'session_expired' } })
  })
})
