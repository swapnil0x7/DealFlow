import { afterEach, describe, expect, it, vi } from 'vitest'
import type { OperationStatus } from '../../api/contracts'
import { TransportError } from '../../api/client'
import { ReceiptRecovery } from './receipt-recovery'

afterEach(() => vi.useRealTimers())

describe('shared receipt recovery', () => {
  it('aborts timed-out reads and never exceeds four outstanding transports even if cancellation is ignored', async () => {
    vi.useFakeTimers()
    const requests: { signal: AbortSignal; finish: () => void }[] = []
    const api = {
      operation: vi.fn(
        (_id: string, signal?: AbortSignal) =>
          new Promise<OperationStatus>((resolve) => {
            requests.push({ signal: signal!, finish: () => resolve({ status: 'unknown' }) })
          }),
      ),
    }
    const recovery = new ReceiptRecovery(api, 10)
    const first = Promise.allSettled(
      Array.from({ length: 4 }, (_, id) => recovery.check(`first-${id}`)),
    )
    await vi.advanceTimersByTimeAsync(10)
    expect(
      (await first).every(
        (result) => result.status === 'rejected' && result.reason instanceof TransportError,
      ),
    ).toBe(true)
    expect(requests.every(({ signal }) => signal.aborted)).toBe(true)
    const next = Promise.allSettled(
      Array.from({ length: 4 }, (_, id) => recovery.check(`next-${id}`)),
    )
    await vi.advanceTimersByTimeAsync(10)
    expect((await next).every((result) => result.status === 'rejected')).toBe(true)
    expect(api.operation).toHaveBeenCalledTimes(4)
    requests.forEach(({ finish }) => finish())
    await vi.advanceTimersByTimeAsync(0)
    const resumed = recovery.check('after-release')
    await vi.advanceTimersByTimeAsync(0)
    expect(api.operation).toHaveBeenCalledTimes(5)
    requests.at(-1)!.finish()
    await expect(resumed).resolves.toEqual({ status: 'unknown' })
    recovery.dispose()
  })

  it('deduplicates a pending check and disposes both active and queued callers', async () => {
    const api = { operation: vi.fn(() => new Promise<OperationStatus>(() => {})) }
    const recovery = new ReceiptRecovery(api)
    const first = recovery.check('same')
    expect(recovery.check('same')).toBe(first)
    const callers = Promise.allSettled([
      first,
      ...Array.from({ length: 5 }, (_, id) => recovery.check(`other-${id}`)),
    ])
    await Promise.resolve()
    expect(api.operation).toHaveBeenCalledTimes(4)
    recovery.dispose()
    expect((await callers).every((result) => result.status === 'rejected')).toBe(true)
    await expect(recovery.check('closed')).rejects.toBeInstanceOf(TransportError)
  })
})
