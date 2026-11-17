import { isStage } from '../domain/deal'
import type { Deal, Stage } from '../domain/deal'
import type { ApiIssue, MoveCommand, MoveResult, OperationStatus, Receipt } from './contracts'

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0
const date = (value: unknown): value is string =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))

export function isDeal(value: unknown): value is Deal {
  return (
    object(value) &&
    text(value.id) &&
    text(value.companyName) &&
    text(value.ownerId) &&
    Number.isSafeInteger(value.valuePaise) &&
    (value.valuePaise as number) >= 0 &&
    Number.isSafeInteger(value.version) &&
    (value.version as number) >= 1 &&
    isStage(value.stage) &&
    date(value.createdAt) &&
    date(value.updatedAt) &&
    (value.lastActivityAt === null || date(value.lastActivityAt))
  )
}

function isIssue(value: unknown): value is ApiIssue {
  return (
    object(value) &&
    text(value.code) &&
    typeof value.message === 'string' &&
    typeof value.retryable === 'boolean'
  )
}

export function isReceipt(value: unknown): value is Receipt {
  return (
    object(value) &&
    text(value.sessionId) &&
    text(value.mutationId) &&
    text(value.actorId) &&
    isStage(value.previousStage) &&
    typeof value.changed === 'boolean' &&
    isDeal(value.record) &&
    date(value.committedAt)
  )
}

export function isMoveResult(value: unknown): value is MoveResult {
  if (!object(value)) return false
  switch (value.status) {
    case 'succeeded':
      return isReceipt(value.receipt) && value.receipt.changed
    case 'skipped':
      return isReceipt(value.receipt) && !value.receipt.changed
    case 'conflicted':
      return isDeal(value.latest)
    case 'failed':
      return isIssue(value.error)
    default:
      return false
  }
}

export function isOperationStatus(value: unknown): value is OperationStatus {
  return (
    object(value) &&
    (value.status === 'completed'
      ? isMoveResult(value.result)
      : value.status === 'unknown' || value.status === 'pending' || value.status === 'retryable')
  )
}

export function receiptMatches(
  value: unknown,
  command: MoveCommand,
  previousStage: Stage,
): value is Receipt {
  return (
    isReceipt(value) &&
    value.sessionId === command.sessionId &&
    value.mutationId === command.mutationId &&
    value.actorId === command.actorId &&
    value.record.id === command.dealId &&
    value.record.stage === command.stage &&
    value.previousStage === previousStage &&
    value.changed === (previousStage !== command.stage) &&
    value.record.version === command.expectedVersion + Number(value.changed)
  )
}

export function resultMatches(
  value: unknown,
  command: MoveCommand,
  previousStage: Stage,
): value is MoveResult {
  if (!isMoveResult(value)) return false
  if (value.status === 'succeeded' || value.status === 'skipped')
    return receiptMatches(value.receipt, command, previousStage)
  return value.status !== 'conflicted' || value.latest.id === command.dealId
}
