import { isStage } from '../domain/deal'
import type { Deal, Owner, Stage } from '../domain/deal'

export interface MoveCommand {
  readonly sessionId: string
  readonly dealId: string
  readonly stage: Stage
  readonly expectedVersion: number
  readonly mutationId: string
  readonly actorId: string
}

export type ErrorCode = 'invalid_request' | 'not_found' | 'mutation_reused' |
  'session_expired' | 'history_full' | 'save_failed' | 'read_failed' | 'offline' | 'response_lost'

export interface ApiIssue { code: ErrorCode; message: string; retryable: boolean }

export class ApiError extends Error {
  readonly issue: ApiIssue
  constructor(code: ErrorCode, message: string, retryable = false) {
    super(message)
    this.name = 'ApiError'
    this.issue = { code, message, retryable }
  }
}

export interface Receipt {
  readonly sessionId: string
  readonly mutationId: string
  readonly actorId: string
  readonly previousStage: Stage
  readonly changed: boolean
  readonly record: Deal
  readonly committedAt: string
}

export type MoveResult =
  | { status: 'succeeded' | 'skipped'; receipt: Receipt }
  | { status: 'conflicted'; latest: Deal }
  | { status: 'failed'; error: ApiIssue }

export interface Snapshot {
  sessionId: string
  deals: Deal[]
  owners: Owner[]
  cursor: number
}

export interface ChangeEvent {
  sequence: number
  mutationId: string
  actorId: string
  record: Deal
}

export interface ChangePage {
  sessionId: string
  changes: ChangeEvent[]
  nextCursor: number
  hasMore: boolean
  resyncRequired: boolean
}

export type OperationStatus =
  | { status: 'unknown' | 'pending' | 'retryable' }
  | { status: 'completed'; result: MoveResult }

export const MAX_BATCH_SIZE = 200

export function parseCommand(value: unknown): MoveCommand {
  if (!value || typeof value !== 'object') throw new ApiError('invalid_request', 'Expected a move command.')
  const input = value as Record<string, unknown>
  const strings = ['sessionId', 'dealId', 'mutationId', 'actorId'] as const
  if (strings.some((key) => typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 200)) {
    throw new ApiError('invalid_request', 'Command identifiers must contain 1–200 characters.')
  }
  if (!isStage(input.stage) || !Number.isSafeInteger(input.expectedVersion) || (input.expectedVersion as number) < 1) {
    throw new ApiError('invalid_request', 'A valid stage and positive integer expectedVersion are required.')
  }
  return {
    sessionId: input.sessionId as string, dealId: input.dealId as string,
    mutationId: input.mutationId as string, actorId: input.actorId as string,
    stage: input.stage, expectedVersion: input.expectedVersion as number,
  }
}
