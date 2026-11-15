import { STAGE_LABELS } from '../../domain/deal'
import type { Operation } from './service'

export const RESULT_LABELS = { queued: 'Queued', saving: 'Saving', succeeded: 'Saved', failed: 'Failed', conflicted: 'Conflict', unconfirmed: 'Unconfirmed', skipped: 'No change needed' }

export function operationLabel(item: Operation): string {
  return item.status === 'saving' || item.status === 'queued'
    ? `${item.kind === 'undo' ? 'Undoing' : 'Moving to'} ${STAGE_LABELS[item.command.stage]}`
    : RESULT_LABELS[item.status]
}
