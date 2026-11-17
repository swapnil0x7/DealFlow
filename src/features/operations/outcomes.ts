import type { ItemState } from './service'

export interface Outcome {
  readonly status: ItemState
  readonly reviewedBy?: string
  readonly keptVersion?: number
}

/** History retains original outcomes; only unresolved decisions contribute to the action badge. */
export function needsAction(item: Outcome): boolean {
  return item.status === 'failed' || item.status === 'unconfirmed' ||
    (item.status === 'conflicted' && !item.reviewedBy && item.keptVersion === undefined)
}

export function resolution(item: Outcome): 'kept' | 'replaced' | undefined {
  return item.keptVersion !== undefined ? 'kept' : item.reviewedBy ? 'replaced' : undefined
}
