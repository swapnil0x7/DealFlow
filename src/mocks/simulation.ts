import { ApiError, MAX_BATCH_SIZE } from '../api/contracts'
import type { MoveCommand, MoveResult } from '../api/contracts'
import { DealRepository } from './repository'
import { seedDeals, seededRandom } from './seed'
import type { Clock, Random } from './seed'

export interface SimulationSettings {
  minSaveDelayMs: number
  maxSaveDelayMs: number
  failureRate: number
  offline: boolean
}

export const DEFAULT_SETTINGS: Readonly<SimulationSettings> = Object.freeze({
  minSaveDelayMs: 300, maxSaveDelayMs: 1_500, failureRate: 0.1, offline: false,
})

type Fault = 'save-failure' | 'read-failure' | 'lost-response'
type Wait = (milliseconds: number, signal: AbortSignal) => Promise<void>
interface SimulationOptions {
  clock?: Clock
  random?: Random
  wait?: Wait
  createData?: (seed: number, clock: Clock) => ReturnType<typeof seedDeals>
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

  constructor(options: SimulationOptions = {}) {
    this.clock = options.clock ?? Date.now
    this.wait = options.wait ?? abortableWait
    this.createData = options.createData ?? ((seed, clock) => seedDeals({ seed, clock }))
    this.injectedRandom = options.random
    this.random = options.random ?? seededRandom(this.seed ^ 0xa5a5a5a5)
    this.repository = this.newRepository()
  }

  private newRepository(): DealRepository {
    return new DealRepository({
      ...this.createData(this.seed, this.clock), sessionId: crypto.randomUUID(), clock: this.clock,
    })
  }

  configuration(): SimulationSettings & { seed: number; sessionId: string } {
    return { ...this.settings, seed: this.seed, sessionId: this.repository.sessionId }
  }

  configure(input: unknown): ReturnType<Simulation['configuration']> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new ApiError('invalid_request', 'Expected simulation settings.')
    const fields = Object.keys(DEFAULT_SETTINGS)
    if (Object.keys(input).some((key) => !fields.includes(key))) throw new ApiError('invalid_request', 'Unknown simulation setting.')
    const next = { ...this.settings, ...input }
    if (!Number.isInteger(next.minSaveDelayMs) || !Number.isInteger(next.maxSaveDelayMs) ||
      next.minSaveDelayMs < 0 || next.maxSaveDelayMs > 30_000 || next.minSaveDelayMs > next.maxSaveDelayMs ||
      typeof next.failureRate !== 'number' || !Number.isFinite(next.failureRate) || next.failureRate < 0 || next.failureRate > 1 ||
      typeof next.offline !== 'boolean') {
      throw new ApiError('invalid_request', 'Delay must be 0–30000 ms, minimum ≤ maximum; failureRate must be 0–1; offline must be boolean.')
    }
    this.settings = next
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
    return repository.changePage(after, sessionId)
  }

  async operation(mutationId: string, sessionId: string) {
    const repository = this.repository
    await this.readBarrier(repository)
    return repository.operation(mutationId, sessionId)
  }

  async move(value: unknown): Promise<MoveResult> {
    this.assertOnline()
    const repository = this.repository
    const signal = this.controller.signal
    const settings = { ...this.settings }
    let loseResponse = false
    const result = await repository.move(value, async () => {
      const fail = this.consume('save-failure') || this.random() < settings.failureRate
      loseResponse = this.consume('lost-response')
      const milliseconds = settings.minSaveDelayMs + Math.floor(this.random() * (settings.maxSaveDelayMs - settings.minSaveDelayMs + 1))
      await this.wait(milliseconds, signal)
      this.assertOnline()
      if (fail) throw new ApiError('save_failed', 'Simulated failure before commit. This command can be retried.', true)
    })
    if (loseResponse && (result.status === 'succeeded' || result.status === 'skipped')) {
      throw new ApiError('response_lost', 'The response was lost after commit. Reconcile before retrying.', true)
    }
    return result
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
    this.repository = this.newRepository()
    return this.configuration()
  }

  dispose(): void {
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
