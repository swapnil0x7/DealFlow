import { ApiError, parseCommand } from '../api/contracts'
import type { ChangeEvent, ChangePage, MoveCommand, MoveResult, OperationStatus, Snapshot } from '../api/contracts'
import type { Deal, Owner } from '../domain/deal'
import type { Clock } from './seed'

interface LedgerEntry {
  command: MoveCommand
  pending?: Promise<MoveResult>
  result?: MoveResult
}

interface RepositoryOptions {
  sessionId: string
  deals: readonly Deal[]
  owners: readonly Owner[]
  clock?: Clock
  maxMutations?: number
  maxChanges?: number
}

export class DealRepository {
  readonly sessionId: string
  private readonly deals: Map<string, Deal>
  private readonly owners: Map<string, Owner>
  private readonly ledger = new Map<string, LedgerEntry>()
  private readonly changes: ChangeEvent[] = []
  private readonly clock: Clock
  private readonly maxMutations: number
  private readonly maxChanges: number
  private sequence = 0
  private active = true

  constructor(options: RepositoryOptions) {
    this.sessionId = options.sessionId
    this.deals = new Map(options.deals.map((deal) => [deal.id, { ...deal }]))
    this.owners = new Map(options.owners.map((owner) => [owner.id, { ...owner }]))
    this.clock = options.clock ?? Date.now
    this.maxMutations = options.maxMutations ?? 100_000
    this.maxChanges = options.maxChanges ?? 10_000
    if (![this.maxChanges, this.maxMutations].every((limit) => Number.isSafeInteger(limit) && limit >= 1)) {
      throw new RangeError('Repository retention limits must be positive safe integers.')
    }
  }

  assertSession(sessionId: string): void {
    if (!this.active || sessionId !== this.sessionId) {
      throw new ApiError('session_expired', 'This simulation session has been reset. Reload the latest snapshot.')
    }
  }

  invalidate(): void { this.active = false }

  record(id: string): Deal {
    this.assertSession(this.sessionId)
    const record = this.deals.get(id)
    if (!record) throw new ApiError('not_found', 'Deal not found.')
    return { ...record }
  }

  snapshot(): Snapshot {
    this.assertSession(this.sessionId)
    return {
      sessionId: this.sessionId, cursor: this.sequence,
      deals: Array.from(this.deals.values(), (deal) => ({ ...deal })),
      owners: Array.from(this.owners.values(), (owner) => ({ ...owner })),
    }
  }

  validate(value: unknown): MoveCommand {
    const command = parseCommand(value)
    this.assertSession(command.sessionId)
    if (!this.deals.has(command.dealId)) throw new ApiError('not_found', 'Deal not found.')
    if (!this.owners.has(command.actorId)) throw new ApiError('invalid_request', 'Unknown actor.')
    return command
  }

  async move(value: unknown, beforeCommit: () => Promise<void> = () => Promise.resolve()): Promise<MoveResult> {
    const command = this.validate(value)
    let entry = this.ledger.get(command.mutationId)
    if (entry && !sameCommand(entry.command, command)) {
      throw new ApiError('mutation_reused', 'A mutation ID cannot be reused with a different command.')
    }
    if (entry?.result && entry.result.status !== 'failed') return structuredClone(entry.result)
    if (entry?.pending) return structuredClone(await entry.pending)
    if (!entry) {
      if (this.ledger.size >= this.maxMutations) {
        throw new ApiError('history_full', 'Session mutation history is full. Inspect outstanding work before resetting.')
      }
      entry = { command }
      this.ledger.set(command.mutationId, entry)
    }
    const currentEntry = entry
    const pending = (async (): Promise<MoveResult> => {
      try {
        await Promise.resolve().then(beforeCommit)
        this.assertSession(command.sessionId)
        // This synchronous section is the commit boundary. Never await between version check and event/receipt creation.
        const current = this.deals.get(command.dealId)!
        let result: MoveResult
        if (current.version !== command.expectedVersion) {
          result = { status: 'conflicted', latest: { ...current } }
        } else {
          const changed = current.stage !== command.stage
          const committedAt = new Date(this.clock()).toISOString()
          const record = changed
            ? { ...current, stage: command.stage, version: current.version + 1, updatedAt: committedAt }
            : { ...current }
          const receipt = {
            sessionId: this.sessionId, mutationId: command.mutationId, actorId: command.actorId,
            previousStage: current.stage, changed, record, committedAt,
          }
          if (changed) {
            this.deals.set(record.id, record)
            const sequence = ++this.sequence
            this.changes[(sequence - 1) % this.maxChanges] = { sequence, mutationId: command.mutationId, actorId: command.actorId, record }
          }
          result = { status: changed ? 'succeeded' : 'skipped', receipt }
        }
        currentEntry.result = result
        return result
      } catch (error) {
        if (error instanceof ApiError && error.issue.code === 'save_failed') {
          const result: MoveResult = { status: 'failed', error: error.issue }
          currentEntry.result = result
          return result
        }
        throw error
      } finally {
        currentEntry.pending = undefined
      }
    })()
    currentEntry.pending = pending
    return structuredClone(await pending)
  }

  operation(mutationId: string, sessionId: string): OperationStatus {
    this.assertSession(sessionId)
    const entry = this.ledger.get(mutationId)
    if (!entry) return { status: 'unknown' }
    if (entry.pending) return { status: 'pending' }
    if (!entry.result || entry.result.status === 'failed') return { status: 'retryable' }
    return { status: 'completed', result: structuredClone(entry.result) }
  }

  changePage(after: number, sessionId: string, limit = 500): ChangePage {
    this.assertSession(sessionId)
    if (!Number.isSafeInteger(after) || after < 0 || after > this.sequence) {
      throw new ApiError('invalid_request', 'Invalid change cursor.')
    }
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new ApiError('invalid_request', 'Change page size must be 1–500.')
    }
    const oldest = Math.max(1, this.sequence - this.maxChanges + 1)
    const resyncRequired = after < oldest - 1
    const changes: ChangeEvent[] = []
    if (!resyncRequired) {
      for (let sequence = after + 1; sequence <= Math.min(this.sequence, after + limit); sequence++) {
        changes.push(this.changes[(sequence - 1) % this.maxChanges])
      }
    }
    const nextCursor = changes.at(-1)?.sequence ?? after
    return structuredClone({
      sessionId: this.sessionId, changes, nextCursor,
      hasMore: !resyncRequired && nextCursor < this.sequence, resyncRequired,
    })
  }
}

function sameCommand(a: MoveCommand, b: MoveCommand): boolean {
  return a.sessionId === b.sessionId && a.dealId === b.dealId && a.stage === b.stage &&
    a.expectedVersion === b.expectedVersion && a.mutationId === b.mutationId && a.actorId === b.actorId
}
