import { TransportError } from '../../api/client'

/** A write deadline stops waiting; it must never imply cancellation of a commit. */
export class RequestDeadlines {
  private readonly timers = new Map<ReturnType<typeof setTimeout>, () => void>()

  private readonly timeoutMs: number

  constructor(timeoutMs = 10_000) {
    this.timeoutMs = timeoutMs
  }

  async wait<T>(request: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        request,
        new Promise<never>((_resolve, reject) => {
          const cancel = () => reject(new TransportError('Request timed out or session closed.'))
          timer = setTimeout(cancel, this.timeoutMs)
          this.timers.set(timer, cancel)
        }),
      ])
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer)
        this.timers.delete(timer)
      }
    }
  }

  dispose(): void {
    this.timers.forEach((cancel, timer) => {
      clearTimeout(timer)
      cancel()
    })
    this.timers.clear()
  }
}
