/** Hints only. Confirmed records and receipts still travel through the HTTP API. */
export type ChangeNotice =
  | {
      readonly kind: 'changes'
      readonly sessionId: string
      readonly cursor: number
    }
  | { readonly kind: 'configuration' | 'reset'; readonly sessionId: string }

export interface ChangeNotificationSource {
  subscribe(listener: (notice: ChangeNotice) => void): () => void
}

/** In-process transport for the browser-only fake API; independent of React and repository data. */
export class ChangeNotificationChannel implements ChangeNotificationSource {
  private readonly listeners = new Set<(notice: ChangeNotice) => void>()

  subscribe(listener: (notice: ChangeNotice) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  publish(notice: ChangeNotice): void {
    const snapshot = Object.freeze({ ...notice })
    for (const listener of Array.from(this.listeners)) {
      // A notification consumer must never turn a committed write into an apparent failed save.
      try {
        listener(snapshot)
      } catch {
        /* Focus/reconnect catch-up can recover a missed hint. */
      }
    }
  }
}

export const changeNotifications = new ChangeNotificationChannel()
