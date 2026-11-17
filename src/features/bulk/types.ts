import type { ApiIssue, MoveCommand, Receipt } from '../../api/contracts'
import type { Deal, Stage } from '../../domain/deal'
import type { ItemState } from '../operations/service'

export const ITEM_STATES: readonly ItemState[] = ['queued', 'saving', 'succeeded', 'failed', 'conflicted', 'unconfirmed', 'skipped']
export type Counts = Record<ItemState, number>
export const emptyCounts = (): Counts => ({ queued: 0, saving: 0, succeeded: 0, failed: 0, conflicted: 0, unconfirmed: 0, skipped: 0 })

export interface PreviewItem {
  readonly command: MoveCommand
  readonly previousStage: Stage
  readonly companyName: string
  readonly valuePaise: number
  readonly changed: boolean
  readonly skipKind?: 'pending' | 'noop' | 'expired'
  readonly skipReason?: string
}
export interface BulkPreview {
  readonly id: string
  readonly kind: 'move' | 'undo'
  readonly source: string
  readonly target: Stage | null
  readonly items: readonly PreviewItem[]
  readonly totalValuePaise: number
  readonly changed: number
  readonly pending: number
  readonly noops: number
  readonly excluded: number
  readonly parent?: { readonly groupId: string; readonly itemId?: string; readonly relation: 'undo' | 'review' }
}
export interface AttemptResult { readonly attempt: number; readonly at: number; readonly status: ItemState; readonly message?: string }
export interface BulkItem extends PreviewItem {
  readonly status: ItemState
  readonly attempts: number
  readonly history: readonly AttemptResult[]
  readonly olderAttempts: number
  readonly canResume: boolean
  readonly checking: boolean
  readonly error?: ApiIssue
  readonly message?: string
  readonly receipt?: Receipt
  readonly conflict?: Deal
  readonly undoId?: string
  readonly reviewedBy?: string
  readonly keptVersion?: number
}
export interface BulkSummary {
  readonly id: string
  readonly kind: 'move' | 'undo'
  readonly source: string
  readonly target: Stage | null
  readonly total: number
  readonly counts: Readonly<Counts>
  readonly createdAt: number
  readonly paused: boolean
  readonly message: string
  readonly checking: boolean
  readonly revision: number
  readonly retryable: number
  readonly resumable: number
  readonly needsAction: number
  readonly parentId?: string
}
