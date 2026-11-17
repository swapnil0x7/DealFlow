import { afterEach, describe, expect, it, vi } from 'vitest'
import { TransportError } from '../../api/client'
import { ApiError } from '../../api/contracts'
import type { MoveCommand } from '../../api/contracts'
import { DealRepository } from '../../mocks/repository'
import { clock, data, deal, deferred } from '../../test/fixtures'
import { ConfirmedReadModel } from '../collaboration/read-model'
import { OperationService } from './service'

function setup(options: { timeoutMs?: number; historyLimit?: number } = {}) {
  const repository = new DealRepository({ sessionId: 'session-1', ...data(), clock })
  const model = new ConfirmedReadModel(repository.snapshot().deals)
  const api = {
    move: vi.fn((command: MoveCommand) => repository.move(command)),
    operation: vi.fn(async (id: string) => repository.operation(id, 'session-1')),
  }
  let count = 0
  const service = new OperationService({
    api,
    model,
    sessionId: 'session-1',
    actorId: 'owner-1',
    clock,
    id: () => `op-${++count}`,
    ...options,
  })
  const item = (id = 'op-1') => service.store.getState().byId[id]
  return { repository, model, api, service, item }
}
afterEach(() => vi.useRealTimers())

describe('single-deal command lifecycle', () => {
  it.each(['mutation', 'actor', 'previous-stage', 'record', 'status'] as const)(
    'keeps a %s mismatch recoverable without accepting another command',
    async (mismatch) => {
      const { api, repository, model, service, item } = setup({ timeoutMs: 10 })
      api.move.mockImplementationOnce(async (command) => {
        const result = await repository.move(command)
        if (result.status !== 'succeeded') throw new Error('Expected a saved receipt')
        if (mismatch === 'mutation')
          result.receipt = { ...result.receipt, mutationId: 'someone-else' }
        if (mismatch === 'actor') result.receipt = { ...result.receipt, actorId: 'owner-2' }
        if (mismatch === 'previous-stage')
          result.receipt = { ...result.receipt, previousStage: 'won' }
        if (mismatch === 'record') result.receipt = { ...result.receipt, record: null! }
        if (mismatch === 'status') return { status: 'unexpected' } as never
        return result
      })
      service.move(deal, 'contacted')
      await vi.waitFor(() => expect(item().status).toBe('unconfirmed'))
      expect(item()).toMatchObject({ checking: false, canResume: false })
      expect(model.get(deal.id)?.version).toBe(1)
      await service.reconcile('op-1')
      expect(item().status).toBe('succeeded')
      expect(model.get(deal.id)?.version).toBe(2)
      expect(api.move).toHaveBeenCalledTimes(1)
      service.dispose()
    },
  )

  it('keeps an explicitly reviewed latest stage without another write and retains the original conflict', async () => {
    const { repository, model, api, service, item } = setup()
    await repository.move({
      sessionId: 'session-1',
      mutationId: 'teammate',
      actorId: 'owner-2',
      dealId: deal.id,
      expectedVersion: 1,
      stage: 'won',
    })
    service.move(model.get(deal.id)!, 'contacted')
    await vi.waitFor(() => expect(item().status).toBe('conflicted'))
    const latest = model.get(deal.id)!
    expect(service.keepLatest('op-1', deal)).toBe(false)
    expect(service.keepLatest('op-1', latest)).toBe(true)
    expect(item()).toMatchObject({ status: 'conflicted', keptVersion: 2 })
    expect(service.activity.get(deal.id)?.resolution).toBe('kept')
    expect(service.review('op-1', latest)).toBeNull()
    expect(service.keepLatest('op-1', latest)).toBe(false)
    expect(api.move).toHaveBeenCalledTimes(1)
    expect(repository.snapshot().deals[0].stage).toBe('won')
    service.dispose()
  })

  it('rejects keeping a review after another known version or after session expiry', async () => {
    const { repository, model, service, item } = setup()
    await repository.move({
      sessionId: 'session-1',
      mutationId: 'teammate',
      actorId: 'owner-2',
      dealId: deal.id,
      expectedVersion: 1,
      stage: 'won',
    })
    service.move(model.get(deal.id)!, 'contacted')
    await vi.waitFor(() => expect(item().status).toBe('conflicted'))
    const reviewed = model.get(deal.id)!
    model.apply([{ ...reviewed, stage: 'lost', version: 3 }])
    expect(service.keepLatest('op-1', reviewed)).toBe(false)
    service.expireSession()
    expect(service.keepLatest('op-1', model.get(deal.id)!)).toBe(false)
    expect(item().keptVersion).toBeUndefined()
    service.dispose()
  })
  it('shows an older command’s explicit retry as current activity after a later local success', async () => {
    const { model, repository, api, service, item } = setup()
    api.move.mockImplementationOnce((command) =>
      repository.move(command, async () => {
        throw new ApiError('save_failed', 'Retry later', true)
      }),
    )
    service.move(model.get(deal.id)!, 'contacted')
    await vi.waitFor(() => expect(item().status).toBe('failed'))
    service.move(model.get(deal.id)!, 'won')
    await vi.waitFor(() => expect(item('op-2').status).toBe('succeeded'))
    const gate = deferred()
    api.move.mockImplementationOnce(async (command) => {
      await gate.promise
      return repository.move(command)
    })
    const retry = service.retry('op-1')
    expect(service.activity.get(deal.id)).toMatchObject({
      id: 'op-1',
      status: 'saving',
      stage: 'contacted',
    })
    expect(service.isBlocked(deal.id)).toBe(true)
    gate.resolve()
    await retry
    expect(service.activity.get(deal.id)).toMatchObject({ id: 'op-1', status: 'conflicted' })
    expect(model.get(deal.id)?.stage).toBe('won')
    service.dispose()
  })

  it('retains confirmed data while saving, blocks overlap on the same deal, and allows other deals', async () => {
    const { repository, model, api, service, item } = setup()
    const gate = deferred()
    api.move.mockImplementationOnce(async (command) => {
      await gate.promise
      return repository.move(command)
    })
    expect(service.move(model.get(deal.id)!, 'contacted')).toBe('op-1')
    expect(item().status).toBe('saving')
    expect(model.get(deal.id)?.stage).toBe('new-lead')
    expect(service.move(model.get(deal.id)!, 'won')).toBeNull()
    expect(service.move(model.get('deal-2')!, 'won')).toBe('op-2')
    gate.resolve()
    await vi.waitFor(() => expect(item().status).toBe('succeeded'))
    expect(model.get(deal.id)).toMatchObject({ stage: 'contacted', version: 2 })
    expect(api.move.mock.calls[0][0]).toMatchObject({
      expectedVersion: 1,
      stage: 'contacted',
      mutationId: 'op-1',
    })
    service.dispose()
  })

  it('retries a definite failure with the original ID/version; a remote change then conflicts instead of rebasing', async () => {
    const { repository, model, api, service, item } = setup()
    api.move.mockImplementationOnce((command) =>
      repository.move(command, async () => {
        throw new ApiError('save_failed', 'Try again', true)
      }),
    )
    service.move(model.get(deal.id)!, 'contacted')
    await vi.waitFor(() => expect(item().status).toBe('failed'))
    expect(model.get(deal.id)?.version).toBe(1)
    await repository.move({
      ...item().command,
      mutationId: 'teammate',
      actorId: 'owner-2',
      stage: 'won',
    })
    await service.retry('op-1')
    expect(item()).toMatchObject({
      status: 'conflicted',
      attempts: 2,
      conflict: { stage: 'won', version: 2 },
    })
    expect(api.move.mock.calls[1][0]).toEqual(api.move.mock.calls[0][0])
    service.dispose()
  })

  it('automatically reconciles a post-commit lost response without issuing a second write', async () => {
    const { repository, model, api, service, item } = setup()
    api.move.mockImplementationOnce(async (command) => {
      await repository.move(command)
      throw new TransportError('lost')
    })
    service.move(model.get(deal.id)!, 'contacted')
    await vi.waitFor(() => expect(item().status).toBe('succeeded'))
    expect(api.move).toHaveBeenCalledTimes(1)
    expect(api.operation).toHaveBeenCalledWith('op-1', expect.any(AbortSignal))
    expect(repository.snapshot().cursor).toBe(1)
    service.dispose()
  })

  it('retains unconfirmed work when reconciliation is unavailable and confirms it on explicit checking', async () => {
    const { repository, model, api, service, item } = setup()
    api.move.mockImplementationOnce(async (command) => {
      await repository.move(command)
      throw new TransportError('lost')
    })
    api.operation.mockRejectedValueOnce(new TransportError('offline'))
    service.move(model.get(deal.id)!, 'contacted')
    await vi.waitFor(() => expect(item()).toMatchObject({ status: 'unconfirmed', checking: false }))
    expect(model.get(deal.id)?.version).toBe(1)
    expect(service.isBlocked(deal.id)).toBe(true)
    expect(service.canDismiss('op-1')).toBe(false)
    expect(service.undo('op-1')).toBeNull()
    await service.reconcile('op-1')
    expect(item().status).toBe('succeeded')
    expect(model.get(deal.id)?.version).toBe(2)
    service.dispose()
  })

  it('checks an unknown outcome again before explicitly retrying the exact original command', async () => {
    const { model, api, service, item } = setup()
    api.move.mockRejectedValueOnce(new TransportError('did not arrive'))
    service.move(model.get(deal.id)!, 'contacted')
    await vi.waitFor(() => expect(item()).toMatchObject({ status: 'unconfirmed', canResume: true }))
    expect(api.move).toHaveBeenCalledTimes(1)
    await service.retry('op-1')
    expect(item().status).toBe('succeeded')
    expect(api.move.mock.calls[1][0]).toEqual(api.move.mock.calls[0][0])
    expect(api.operation).toHaveBeenCalledTimes(2)
    service.dispose()
  })

  it('does not downgrade a feed-confirmed success on a late HTTP error or regress a newer read-model version', async () => {
    const { repository, model, api, service, item } = setup()
    const gate = deferred()
    api.move.mockImplementationOnce(async (command) => {
      await gate.promise
      await repository.move(command)
      throw new TransportError('late failure')
    })
    service.move(model.get(deal.id)!, 'contacted')
    model.apply([{ ...deal, stage: 'won', version: 3 }])
    service.confirmChange({
      sequence: 1,
      mutationId: 'op-1',
      actorId: 'owner-1',
      record: { ...deal, stage: 'contacted', version: 2 },
    })
    expect(item().status).toBe('succeeded')
    gate.resolve()
    await vi.waitFor(() => expect(repository.snapshot().cursor).toBe(1))
    expect(item().status).toBe('succeeded')
    expect(model.get(deal.id)).toMatchObject({ stage: 'won', version: 3 })
    expect(service.canUndo('op-1')).toBe(false)
    service.dispose()
  })

  it('times out without assuming cancellation, keeps a pending receipt unresolved, then accepts the late result', async () => {
    const { repository, model, api, service, item } = setup({ timeoutMs: 5 })
    const gate = deferred()
    api.move.mockImplementationOnce((command) => repository.move(command, () => gate.promise))
    service.move(model.get(deal.id)!, 'contacted')
    await vi.waitFor(() =>
      expect(item()).toMatchObject({ status: 'unconfirmed', canResume: false, checking: false }),
    )
    expect(model.get(deal.id)?.version).toBe(1)
    gate.resolve()
    await vi.waitFor(() => expect(item().status).toBe('succeeded'))
    expect(api.move).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('creates guarded Undo once, restores the original stage, and never changes customer activity', async () => {
    const { model, service, item } = setup()
    service.move(model.get(deal.id)!, 'contacted')
    await vi.waitFor(() => expect(item().status).toBe('succeeded'))
    expect(service.undo('op-1')).toBe('op-2')
    expect(service.undo('op-1')).toBeNull()
    await vi.waitFor(() => expect(item('op-2').status).toBe('succeeded'))
    expect(item('op-2')).toMatchObject({
      kind: 'undo',
      parentId: 'op-1',
      command: { expectedVersion: 2, stage: 'new-lead', mutationId: 'op-2' },
    })
    expect(item().status).toBe('succeeded')
    expect(model.get(deal.id)).toMatchObject({
      stage: 'new-lead',
      version: 3,
      lastActivityAt: null,
    })
    service.dispose()
  })

  it('conflicts on Undo after an unseen teammate edit, preserving both original success and the newer stage', async () => {
    const { repository, model, service, item } = setup()
    service.move(model.get(deal.id)!, 'contacted')
    await vi.waitFor(() => expect(item().status).toBe('succeeded'))
    await repository.move({
      ...item().command,
      expectedVersion: 2,
      mutationId: 'other',
      actorId: 'owner-2',
      stage: 'won',
    })
    service.undo('op-1')
    await vi.waitFor(() => expect(item('op-2').status).toBe('conflicted'))
    expect(item().status).toBe('succeeded')
    expect(model.get(deal.id)).toMatchObject({ stage: 'won', version: 3 })
    service.dispose()
  })

  it('reviews a captured latest version with a new ID; a second intervening edit conflicts again', async () => {
    const { repository, model, service, item } = setup()
    const initial = model.get(deal.id)!
    await repository.move({
      dealId: deal.id,
      stage: 'won',
      expectedVersion: 1,
      mutationId: 'remote-1',
      actorId: 'owner-2',
      sessionId: 'session-1',
    })
    service.move(initial, 'negotiation')
    await vi.waitFor(() => expect(item().status).toBe('conflicted'))
    const reviewed = model.get(deal.id)!
    await repository.move({
      ...item().command,
      expectedVersion: 2,
      mutationId: 'remote-2',
      actorId: 'owner-2',
      stage: 'lost',
    })
    expect(service.review('op-1', reviewed)).toBe('op-2')
    await vi.waitFor(() => expect(item('op-2').status).toBe('conflicted'))
    expect(item('op-2').command.expectedVersion).toBe(2)
    expect(service.review('op-1', reviewed)).toBeNull()
    expect(service.review('op-2', model.get(deal.id)!)).toBe('op-3')
    await vi.waitFor(() => expect(item('op-3').status).toBe('succeeded'))
    expect(model.get(deal.id)).toMatchObject({ stage: 'negotiation', version: 4 })
    service.dispose()
  })

  it('bounds history without silently losing an Undoable result, and frees space only on explicit dismissal', async () => {
    const { model, service, item } = setup({ historyLimit: 1 })
    service.move(model.get(deal.id)!, 'contacted')
    await vi.waitFor(() => expect(item().status).toBe('succeeded'))
    expect(service.move(model.get('deal-2')!, 'won')).toBeNull()
    expect(service.store.getState().notice).toContain('results are full')
    expect(service.canUndo('op-1')).toBe(true)
    service.dismiss('op-1')
    expect(service.store.getState().order).toEqual([])
    expect(service.move(model.get('deal-2')!, 'won')).toBe('op-2')
    service.dispose()
  })

  it('reports same-stage commands as skipped and does not offer Undo', async () => {
    const { model, service, item } = setup()
    service.move(model.get(deal.id)!, 'new-lead')
    await vi.waitFor(() => expect(item().status).toBe('skipped'))
    expect(service.canUndo('op-1')).toBe(false)
    expect(model.get(deal.id)?.version).toBe(1)
    service.dispose()
  })

  it('ignores late callbacks and clears timeout handles on disposal', async () => {
    vi.useFakeTimers()
    const { repository, model, api, service } = setup()
    const gate = deferred()
    api.move.mockImplementationOnce(async (command) => {
      await gate.promise
      return repository.move(command)
    })
    service.move(model.get(deal.id)!, 'won')
    expect(vi.getTimerCount()).toBe(1)
    service.dispose()
    expect(vi.getTimerCount()).toBe(0)
    gate.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(model.get(deal.id)?.version).toBe(1)
  })

  it('blocks further commands after session expiry and retains an honest unconfirmed outcome', async () => {
    const { model, api, service, item } = setup()
    api.move.mockRejectedValueOnce(new ApiError('session_expired', 'Session reset'))
    service.move(model.get(deal.id)!, 'won')
    await vi.waitFor(() => expect(service.store.getState().sessionExpired).toBe(true))
    expect(item().status).toBe('unconfirmed')
    expect(service.move(model.get('deal-2')!, 'won')).toBeNull()
    service.dispose()
  })

  it('reconciles missed receipts after resync without rewriting the captured version or issuing another save', async () => {
    const { repository, model, api, service, item } = setup()
    api.move.mockImplementationOnce(async (command) => {
      await repository.move(command)
      throw new TransportError('lost')
    })
    api.operation.mockRejectedValueOnce(new TransportError('feed/read unavailable'))
    service.move(model.get(deal.id)!, 'contacted')
    await vi.waitFor(() => expect(item()).toMatchObject({ status: 'unconfirmed', checking: false }))
    const captured = item().command
    model.apply(repository.snapshot().deals)
    await service.reconcileOutstanding()
    expect(item().status).toBe('succeeded')
    expect(item().command).toBe(captured)
    expect(item().command.expectedVersion).toBe(1)
    expect(api.move).toHaveBeenCalledTimes(1)
    service.dispose()
  })

  it('publishes only tracked known versions so live changes hide stale Undo and releases the subscription on disposal', async () => {
    const { model, service, item } = setup()
    service.move(model.get(deal.id)!, 'contacted')
    await vi.waitFor(() => expect(item().status).toBe('succeeded'))
    expect(service.canUndo('op-1')).toBe(true)
    model.apply([
      { ...deal, stage: 'won', version: 3 },
      { ...deal, id: 'deal-2', version: 4 },
    ])
    expect(service.store.getState().knownVersions).toEqual({ [deal.id]: 3 })
    expect(service.canUndo('op-1')).toBe(false)
    service.dispose()
    model.apply([{ ...deal, version: 5 }])
    expect(service.store.getState().knownVersions[deal.id]).toBe(3)
  })
})
