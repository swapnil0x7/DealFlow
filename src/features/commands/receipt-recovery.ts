import type { DealApi } from '../../api/client'
import { TransportError } from '../../api/client'
import type { OperationStatus } from '../../api/contracts'

interface Check {
  id: string
  controller: AbortController
  settled: boolean
  timer: ReturnType<typeof setTimeout>
  resolve: (result: OperationStatus) => void
  reject: (error: unknown) => void
}

/** Shared receipt GET budget. An uncooperative transport cannot free a physical slot on timeout. */
export class ReceiptRecovery {
  private readonly active = new Set<Check>()
  private readonly queue: Check[] = []
  private readonly pending = new Map<string, Promise<OperationStatus>>()
  private disposed = false

  private readonly api: Pick<DealApi, 'operation'>
  private readonly timeoutMs: number
  private readonly concurrency: number

  constructor(api: Pick<DealApi, 'operation'>, timeoutMs = 10_000, concurrency = 4) {
    this.api = api
    this.timeoutMs = timeoutMs
    this.concurrency = concurrency
  }

  check(id: string): Promise<OperationStatus> {
    if (this.disposed) return Promise.reject(new TransportError('Receipt recovery is closed.'))
    const existing = this.pending.get(id)
    if (existing) return existing
    let check!: Check
    const promise = new Promise<OperationStatus>((resolve, reject) => {
      check = {
        id,
        controller: new AbortController(),
        settled: false,
        resolve,
        reject,
        // Queue wait is bounded too when all active transports ignore cancellation.
        timer: setTimeout(() => {
          check.controller.abort()
          this.settle(check, undefined, new TransportError('Receipt check timed out.'))
          const index = this.queue.indexOf(check)
          if (index >= 0) this.queue.splice(index, 1)
        }, this.timeoutMs),
      }
    })
    this.pending.set(id, promise)
    this.queue.push(check)
    this.pump()
    return promise
  }

  private settle(check: Check, result?: OperationStatus, error?: unknown): void {
    if (check.settled) return
    check.settled = true
    clearTimeout(check.timer)
    this.pending.delete(check.id)
    if (result) check.resolve(result)
    else check.reject(error)
  }

  private pump(): void {
    while (!this.disposed && this.active.size < this.concurrency && this.queue.length) {
      const check = this.queue.shift()!
      if (check.settled) continue
      this.active.add(check)
      void Promise.resolve()
        .then(() => {
          if (this.disposed || check.controller.signal.aborted)
            throw new TransportError('Receipt check cancelled.')
          return this.api.operation(check.id, check.controller.signal)
        })
        .then(
          (result) => this.settle(check, result),
          (error: unknown) => this.settle(check, undefined, error),
        )
        .finally(() => {
          this.active.delete(check)
          this.pump()
        })
    }
  }

  dispose(): void {
    this.disposed = true
    for (const check of [...this.active, ...this.queue]) {
      check.controller.abort()
      this.settle(check, undefined, new TransportError('Receipt recovery is closed.'))
    }
    this.queue.length = 0
  }
}
