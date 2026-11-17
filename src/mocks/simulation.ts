import { ApiError, MAX_BATCH_SIZE } from '../api/contracts'
import type { MoveCommand, MoveResult } from '../api/contracts'
import type { SimulationConfiguration, SimulationFault, SimulationSettings } from '../api/simulation-contracts'
import type { ChangeNotice } from '../api/change-notifications'
import { STAGES } from '../domain/deal'
import { CURRENT_OWNER_ID } from '../domain/filters'
import { DealRepository } from './repository'
import { seedDeals, seededRandom } from './seed'
import type { Clock, Random } from './seed'

export type { SimulationSettings } from '../api/simulation-contracts'

export const DEFAULT_SETTINGS: Readonly<SimulationSettings> = Object.freeze({
  minSaveDelayMs: 300, maxSaveDelayMs: 1_500, failureRate: 0.1, offline: false,
  teammatesEnabled: false, teammateIntervalMs: 4_000, changeDeliveryPaused: false,
})

type Fault = SimulationFault
type Wait = (milliseconds: number, signal: AbortSignal) => Promise<void>
interface SimulationOptions {
  clock?: Clock
  random?: Random
  wait?: Wait
  createData?: (seed: number, clock: Clock) => ReturnType<typeof seedDeals>
  onNotification?: (notice: ChangeNotice) => void
}

export class Simulation {
  private settings: SimulationSettings = { ...DEFAULT_SETTINGS }
  private repository: DealRepository
  private controller = new AbortController()
  private readonly clock: Clock
  private readonly wait: Wait
  private readonly createData: NonNullable<SimulationOptions['createData']>
  private readonly injectedRandom?: Random
  private random: Random
  private seed = 42
  private faults: Record<Fault, number> = { 'save-failure': 0, 'read-failure': 0, 'lost-response': 0 }
  private dealIds: string[] = []
  private teammateIds: string[] = []
  private teammateTimer: ReturnType<typeof setTimeout> | undefined
  private teammateController = new AbortController()
  private teammateGeneration = 0
  private disposed = false
  private readonly onNotification: SimulationOptions['onNotification']

  constructor(options: SimulationOptions = {}) {
    this.clock = options.clock ?? Date.now
    this.wait = options.wait ?? abortableWait
    this.createData = options.createData ?? ((seed, clock) => seedDeals({ seed, clock }))
    this.injectedRandom = options.random
    this.random = options.random ?? seededRandom(this.seed ^ 0xa5a5a5a5)
    this.onNotification = options.onNotification
    this.repository = this.newRepository()
  }

  private newRepository(): DealRepository {
    const data = this.createData(this.seed, this.clock)
    this.dealIds = data.deals.map((deal) => deal.id)
    this.teammateIds = data.owners.filter((owner) => owner.id !== CURRENT_OWNER_ID).map((owner) => owner.id)
    return new DealRepository({
      ...data, sessionId: crypto.randomUUID(), clock: this.clock,
      onChange: (sessionId, cursor) => this.notify({ kind: 'changes', sessionId, cursor }),
    })
  }

  configuration(): SimulationConfiguration {
    return { ...this.settings, seed: this.seed, sessionId: this.repository.sessionId }
  }

  assertSession(sessionId: string): void { this.repository.assertSession(sessionId) }

  private notify(notice: ChangeNotice): void {
    try { this.onNotification?.(notice) } catch { /* Observer failure does not change saved state or controls. */ }
  }

  configure(input: unknown): ReturnType<Simulation['configuration']> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('invalid_request', 'Expected simulation settings.')
    const fields = Object.keys(DEFAULT_SETTINGS)
    if (Object.keys(input).some((key) => !fields.includes(key))) throw new ApiError('invalid_request', 'Unknown simulation setting.')
    const next = { ...this.settings, ...input }
    if (!Number.isInteger(next.minSaveDelayMs) || !Number.isInteger(next.maxSaveDelayMs) ||
      next.minSaveDelayMs < 0 || next.maxSaveDelayMs > 30_000 || next.minSaveDelayMs > next.maxSaveDelayMs ||
      typeof next.failureRate !== 'number' || !Number.isFinite(next.failureRate) || next.failureRate < 0 || next.failureRate > 1 ||
      typeof next.offline !== 'boolean' || typeof next.teammatesEnabled !== 'boolean' || typeof next.changeDeliveryPaused !== 'boolean' ||
      !Number.isInteger(next.teammateIntervalMs) || next.teammateIntervalMs < 500 || next.teammateIntervalMs > 30_000) {
      throw new ApiError('invalid_request', 'Delay must be 0–30000 ms with minimum ≤ maximum; failureRate 0–1; teammate interval 500–30000 ms; switches must be booleans.')
    }
    const restart = next.teammatesEnabled !== this.settings.teammatesEnabled || next.teammateIntervalMs !== this.settings.teammateIntervalMs || next.offline !== this.settings.offline
    const deliveryChanged = next.offline !== this.settings.offline || next.changeDeliveryPaused !== this.settings.changeDeliveryPaused
    this.settings = next
    if (restart) { this.stopTeammates(); this.scheduleTeammate() }
    if (deliveryChanged) this.notify({ kind: 'configuration', sessionId: this.repository.sessionId })
    return this.configuration()
  }

  forceFault(fault: unknown): void {
    if (fault !== 'save-failure' && fault !== 'read-failure' && fault !== 'lost-response') {
      throw new ApiError('invalid_request', 'Unknown fault scenario.')
    }
    this.faults[fault]++
  }

  private consume(fault: Fault): boolean {
    if (!this.faults[fault]) return false
    this.faults[fault]--
    return true
  }

  private assertOnline(): void {
    if (this.settings.offline) throw new ApiError('offline', 'Simulation is offline. The save outcome may need reconciliation.', true)
  }

  private async readBarrier(repository: DealRepository): Promise<void> {
    this.assertOnline()
    await this.wait(20, this.controller.signal)
    repository.assertSession(this.repository.sessionId)
    this.assertOnline()
    if (this.consume('read-failure')) throw new ApiError('read_failed', 'Simulated read failure. Try again.', true)
  }

  async snapshot() {
    const repository = this.repository
    await this.readBarrier(repository)
    return repository.snapshot()
  }

  async changes(after: number, sessionId: string) {
    const repository = this.repository
    await this.readBarrier(repository)
    const page = repository.changePage(after, sessionId)
    if (this.settings.changeDeliveryPaused) {
      return { sessionId, changes: [], nextCursor: after, hasMore: false, resyncRequired: false, deliveryPaused: true }
    }
    return page
  }

  async operation(mutationId: string, sessionId: string) {
    const repository = this.repository
    await this.readBarrier(repository)
    return repository.operation(mutationId, sessionId)
  }

  async move(value: unknown): Promise<MoveResult> { return this.save(value, this.controller.signal, true) }

  private async save(value: unknown, signal: AbortSignal, userFaults: boolean): Promise<MoveResult> {
    this.assertOnline()
    const repository = this.repository
    const settings = { ...this.settings }
    let loseResponse = false
    const result = await repository.move(value, async () => {
      const fail = (userFaults && this.consume('save-failure')) || this.random() < settings.failureRate
      loseResponse = userFaults && this.consume('lost-response')
      const milliseconds = settings.minSaveDelayMs + Math.floor(this.random() * (settings.maxSaveDelayMs - settings.minSaveDelayMs + 1))
      await this.wait(milliseconds, signal)
      if (signal.aborted) throw new ApiError('session_expired', 'Scheduled simulation work was cancelled.')
      this.assertOnline()
      if (fail) throw new ApiError('save_failed', 'Simulated failure before commit. This command can be retried.', true)
    })
    if (loseResponse && (result.status === 'succeeded' || result.status === 'skipped')) {
      throw new ApiError('response_lost', 'The response was lost after commit. Reconcile before retrying.', true)
    }
    return result
  }

  /** A repeatable unseen edit; it still uses the repository's commit-time version guard. */
  async conflict(dealId: unknown): Promise<MoveResult> {
    this.assertOnline()
    if (typeof dealId !== 'string' || !this.teammateIds.length) throw new ApiError('invalid_request', 'Choose a valid deal and teammate.')
    const record = this.repository.record(dealId)
    return this.repository.move({ sessionId: this.repository.sessionId, dealId, actorId: this.teammateIds[0],
      expectedVersion: record.version, mutationId: crypto.randomUUID(), stage: STAGES[(STAGES.indexOf(record.stage) + 1) % STAGES.length] })
  }

  private stopTeammates(): void {
    this.teammateGeneration++
    clearTimeout(this.teammateTimer)
    this.teammateTimer = undefined
    this.teammateController.abort()
    this.teammateController = new AbortController()
  }

  private scheduleTeammate(): void {
    if (this.disposed || !this.settings.teammatesEnabled || this.settings.offline || !this.dealIds.length || !this.teammateIds.length) return
    const generation = this.teammateGeneration
    this.teammateTimer = setTimeout(async () => {
      this.teammateTimer = undefined
      const record = this.repository.record(this.dealIds[Math.floor(this.random() * this.dealIds.length)])
      const choices = STAGES.filter((stage) => stage !== record.stage)
      try {
        await this.save({ sessionId: this.repository.sessionId, dealId: record.id, expectedVersion: record.version,
          stage: choices[Math.floor(this.random() * choices.length)], actorId: this.teammateIds[Math.floor(this.random() * this.teammateIds.length)],
          mutationId: crypto.randomUUID() }, this.teammateController.signal, false)
      } catch {
        // Teammates can lose races or be interrupted too. Never bypass the guard to force a save.
      } finally {
        if (generation === this.teammateGeneration) this.scheduleTeammate()
      }
    }, this.settings.teammateIntervalMs)
  }

  async bulk(values: unknown): Promise<{ results: { mutationId: string; dealId: string; result: MoveResult }[] }> {
    if (!Array.isArray(values) || values.length < 1 || values.length > MAX_BATCH_SIZE) {
      throw new ApiError('invalid_request', `A batch must contain 1–${MAX_BATCH_SIZE} commands.`)
    }
    // Validate the entire envelope before launching work; malformed batches never partially mutate.
    const commands: MoveCommand[] = values.map((value) => this.repository.validate(value))
    if (new Set(commands.map((command) => command.mutationId)).size !== commands.length ||
      new Set(commands.map((command) => command.dealId)).size !== commands.length) {
      throw new ApiError('invalid_request', 'Each batch requires unique deal IDs and mutation IDs.')
    }
    const settled = await Promise.allSettled(commands.map(async (command) => ({
      mutationId: command.mutationId, dealId: command.dealId, result: await this.move(command),
    })))
    // Even after one response is lost, wait for the launched batch to settle before returning uncertainty.
    const interrupted = settled.find((item) => item.status === 'rejected' &&
      (!(item.reason instanceof ApiError) || ['offline', 'response_lost', 'session_expired'].includes(item.reason.issue.code)))
    if (interrupted?.status === 'rejected') throw interrupted.reason
    return {
      results: settled.map((item, index) => item.status === 'fulfilled' ? item.value : {
        mutationId: commands[index].mutationId, dealId: commands[index].dealId,
        result: { status: 'failed' as const, error: (item.reason as ApiError).issue },
      }),
    }
  }

  reset(seed: unknown = 42): ReturnType<Simulation['configuration']> {
    if (!Number.isInteger(seed) || (seed as number) < 0 || (seed as number) > 0xffff_ffff) {
      throw new ApiError('invalid_request', 'Seed must be an unsigned 32-bit integer.')
    }
    this.dispose()
    this.seed = seed as number
    this.settings = { ...DEFAULT_SETTINGS }
    this.faults = { 'save-failure': 0, 'read-failure': 0, 'lost-response': 0 }
    this.random = this.injectedRandom ?? seededRandom(this.seed ^ 0xa5a5a5a5)
    this.controller = new AbortController()
    this.disposed = false
    this.repository = this.newRepository()
    this.notify({ kind: 'reset', sessionId: this.repository.sessionId })
    return this.configuration()
  }

  dispose(): void {
    this.disposed = true
    this.stopTeammates()
    this.repository.invalidate()
    this.controller.abort()
  }
}

export const abortableWait: Wait = (milliseconds, signal) => new Promise((resolve, reject) => {
  const cancel = () => {
    clearTimeout(timer)
    reject(new ApiError('session_expired', 'The simulation session was reset.'))
  }
  if (signal.aborted) { reject(new ApiError('session_expired', 'The simulation session was reset.')); return }
  const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve() }, milliseconds)
  signal.addEventListener('abort', cancel, { once: true })
})
