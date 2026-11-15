import { createStore } from 'zustand/vanilla'
import { ApiError } from '../../api/contracts'
import type { ChangePage, Snapshot } from '../../api/contracts'
import type { DealApi } from '../../api/client'
import type { ConfirmedReadModel } from './read-model'
import type { OperationService } from '../operations/service'

export type ConnectionStatus = 'connecting' | 'live' | 'paused' | 'offline' | 'hidden' | 'reconnecting' | 'resyncing' | 'expired'
interface FeedState {
  status: ConnectionStatus
  cursor: number
  received: number
  resyncs: number
  message: string
}
interface Options {
  api: Pick<DealApi, 'changes' | 'resync' | 'simulation'>
  model: ConfirmedReadModel
  operations: Pick<OperationService, 'confirmChange' | 'reconcileOutstanding' | 'expireSession'>
  sessionId: string
  cursor: number
  intervalMs?: number
  timeoutMs?: number
  /** Selection code may observe resync, but must retain its own captured ID/version snapshots. */
  onResync?: (snapshot: Snapshot) => void
}

/** One current request chain, ordered cursor commits, and cancellation/generation guards for every await. */
export class ChangeFeed {
  readonly store
  private readonly options: Options
  private cursor: number
  private timer: ReturnType<typeof setTimeout> | undefined
  private deadline: ReturnType<typeof setTimeout> | undefined
  private flight: AbortController | undefined
  private visible = true
  private networkOnline = true
  private simulationOffline = false
  private running = false
  private disposed = false
  private expired = false
  private settingsNeeded = false
  private wakePending = false

  constructor(options: Options) {
    this.options = options
    this.cursor = options.cursor
    this.store = createStore<FeedState>(() => ({ status: 'connecting', cursor: this.cursor, received: 0, resyncs: 0, message: 'Connecting live updates…' }))
  }

  start(): () => void {
    if (!this.disposed && !this.expired && !this.running) { this.running = true; this.schedule(this.options.intervalMs ?? 1_000) }
    return () => this.stop()
  }

  stop(): void { this.running = false; this.cancel() }
  dispose(): void { this.disposed = true; this.stop() }

  private cancel(): void {
    clearTimeout(this.timer)
    clearTimeout(this.deadline)
    this.timer = undefined
    this.flight?.abort()
    this.flight = undefined
    this.wakePending = false
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    if (!visible) { this.cancel(); this.store.setState({ status: 'hidden', message: 'Live updates paused while this page is hidden.' }) }
    else this.wake()
  }

  setNetworkOnline(online: boolean): void {
    this.networkOnline = online
    if (!online) { this.cancel(); this.store.setState({ status: 'offline', message: 'Offline. Live updates will catch up after reconnecting.' }) }
    else this.wake()
  }

  setSimulationOffline(offline: boolean): void {
    this.simulationOffline = offline
    if (offline) { this.cancel(); this.store.setState({ status: 'offline', message: 'Offline simulation. Saves and live delivery are interrupted.' }) }
    else this.wake()
  }

  wake(): void {
    if (this.disposed || this.expired) return
    this.settingsNeeded = true
    if (this.flight) this.wakePending = true
    else this.schedule(0)
  }

  private eligible(): boolean {
    return this.running && !this.disposed && !this.expired && this.visible && this.networkOnline && (!this.simulationOffline || this.settingsNeeded)
  }

  private schedule(delay: number): void {
    clearTimeout(this.timer)
    if (this.eligible() && !this.flight) this.timer = setTimeout(() => { this.timer = undefined; void this.poll() }, delay)
  }

  private current(controller: AbortController): boolean {
    return this.flight === controller && !controller.signal.aborted && this.running && !this.disposed && this.visible && this.networkOnline
  }

  private validate(page: ChangePage): void {
    if (page.sessionId !== this.options.sessionId) throw new ApiError('session_expired', 'The simulation session changed.')
    if (page.resyncRequired || page.deliveryPaused) return
    let expected = this.cursor
    for (const event of page.changes) {
      if (event.sequence !== ++expected) throw new Error('Change feed sequence gap. A fresh snapshot is required.')
    }
    if (page.nextCursor !== expected || (page.hasMore && !page.changes.length)) throw new Error('Invalid change cursor.')
  }

  private async resync(controller: AbortController): Promise<void> {
    this.store.setState({ status: 'resyncing', message: 'Catching up from a fresh snapshot. Captured versions stay unchanged.' })
    const snapshot = await this.options.api.resync(controller.signal)
    if (!this.current(controller)) return
    if (snapshot.sessionId !== this.options.sessionId) throw new ApiError('session_expired', 'The simulation session changed.')
    this.options.model.apply(snapshot.deals)
    this.options.onResync?.(snapshot)
    this.cursor = snapshot.cursor
    this.store.setState((state) => ({ cursor: this.cursor, resyncs: state.resyncs + 1 }))
    void this.options.operations.reconcileOutstanding()
  }

  private expire(): void {
    this.expired = true
    this.options.operations.expireSession()
    this.store.setState({ status: 'expired', message: 'This simulation session expired. Reload the workspace.' })
  }

  private async poll(): Promise<void> {
    if (!this.eligible() || this.flight) return
    const controller = new AbortController()
    this.flight = controller
    this.deadline = setTimeout(() => {
      if (this.current(controller)) {
        this.cancel()
        this.store.setState({ status: 'reconnecting', message: 'Live update request timed out. Reconnecting from the last applied cursor.' })
        this.schedule(this.options.intervalMs ?? 1_000)
      }
    }, this.options.timeoutMs ?? 10_000)
    let more = false
    try {
      if (this.settingsNeeded) {
        this.settingsNeeded = false
        const configuration = await this.options.api.simulation(controller.signal)
        if (!this.current(controller)) return
        if (configuration.sessionId !== this.options.sessionId) throw new ApiError('session_expired', 'The simulation session changed.')
        this.simulationOffline = configuration.offline
      }
      if (this.simulationOffline) {
        this.store.setState({ status: 'offline', message: 'Offline simulation. Saves and live delivery are interrupted.' })
        return
      }
      for (let pageNumber = 0; pageNumber < 5; pageNumber++) {
        const page = await this.options.api.changes(this.cursor, controller.signal)
        if (!this.current(controller)) return
        try { this.validate(page) } catch (error) {
          if (error instanceof ApiError) throw error
          await this.resync(controller)
          more = true
          break
        }
        if (page.resyncRequired) { await this.resync(controller); more = true; break }
        if (page.deliveryPaused) {
          this.store.setState({ status: 'paused', message: 'Live change delivery is paused in Simulation.' })
          return
        }
        this.options.model.apply(page.changes.map((event) => event.record))
        for (const event of page.changes) this.options.operations.confirmChange(event)
        // Only advance after the entire page and every operation confirmation have been applied.
        this.cursor = page.nextCursor
        this.store.setState((state) => ({ cursor: this.cursor, received: state.received + page.changes.length,
          status: 'live', message: 'Live updates connected.' }))
        more = page.hasMore
        if (!more) break
      }
    } catch (error) {
      if (!this.current(controller)) return
      if (error instanceof ApiError && error.issue.code === 'session_expired') {
        this.expire()
      } else {
        this.store.setState({ status: 'reconnecting', message: 'Live updates interrupted. Retrying without changing saved commands.' })
        // The local control plane remains available during simulated offline mode.
        try {
          const settings = await this.options.api.simulation(controller.signal)
          if (this.current(controller)) {
            if (settings.sessionId !== this.options.sessionId) this.expire()
            else {
              this.simulationOffline = settings.offline
              if (settings.offline) this.store.setState({ status: 'offline', message: 'Offline simulation. Reconnect in Simulation.' })
            }
          }
        } catch { /* A real network interruption is retried when connectivity returns. */ }
      }
    } finally {
      if (this.flight === controller) {
        clearTimeout(this.deadline)
        this.flight = undefined
        const immediate = this.wakePending || more
        this.wakePending = false
        this.schedule(immediate ? 0 : this.options.intervalMs ?? 1_000)
      }
    }
  }
}
