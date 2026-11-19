import type { BulkSummary } from './types'
import { ITEM_STATES } from './types'

interface Entry {
  groupId: string
  dealId: string
}

/** Index Undo candidates by affected deal; history rendering never scans a complete operation. */
export class BulkUndoIndex {
  private readonly entries = new Map<string, Entry>()
  private readonly byDeal = new Map<string, Set<string>>()
  private readonly byGroup = new Map<string, Set<string>>()
  private readonly eligible = new Map<string, Set<string>>()
  private readonly canUndo: (id: string) => boolean

  constructor(canUndo: (id: string) => boolean) {
    this.canUndo = canUndo
  }

  register(groupId: string, id: string, dealId: string): void {
    this.entries.set(id, { groupId, dealId })
    const deal = this.byDeal.get(dealId) ?? new Set<string>()
    const group = this.byGroup.get(groupId) ?? new Set<string>()
    deal.add(id)
    group.add(id)
    this.byDeal.set(dealId, deal)
    this.byGroup.set(groupId, group)
  }

  refresh(dealIds: readonly string[]): ReadonlySet<string> {
    const changed = new Set<string>()
    for (const dealId of dealIds) {
      for (const id of this.byDeal.get(dealId) ?? []) {
        const { groupId } = this.entries.get(id)!
        const eligible = this.eligible.get(groupId) ?? new Set<string>()
        const next = this.canUndo(id)
        if (eligible.has(id) === next) continue
        if (next) eligible.add(id)
        else eligible.delete(id)
        this.eligible.set(groupId, eligible)
        changed.add(groupId)
      }
    }
    return changed
  }

  candidates(groupId: string): readonly string[] {
    return Array.from(this.eligible.get(groupId) ?? [])
  }

  count(groupId: string): number {
    return this.eligible.get(groupId)?.size ?? 0
  }

  unregister(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    const deal = this.byDeal.get(entry.dealId)!
    deal.delete(id)
    if (!deal.size) this.byDeal.delete(entry.dealId)
    this.byGroup.get(entry.groupId)?.delete(id)
    this.eligible.get(entry.groupId)?.delete(id)
    this.entries.delete(id)
  }

  remove(groupId: string): void {
    for (const id of this.byGroup.get(groupId) ?? []) this.unregister(id)
    this.byGroup.delete(groupId)
    this.eligible.delete(groupId)
  }

  clear(): void {
    this.entries.clear()
    this.byDeal.clear()
    this.byGroup.clear()
    this.eligible.clear()
  }
}

/** Preserve unchanged group identities so unrelated progress does not rerender their result pages. */
export function stableSummary(next: BulkSummary, previous?: BulkSummary): BulkSummary {
  const equal =
    previous &&
    (Object.keys(next) as (keyof BulkSummary)[]).every((key) =>
      key === 'counts'
        ? ITEM_STATES.every((status) => next.counts[status] === previous.counts[status])
        : next[key] === previous[key],
    )
  if (equal) return previous
  return Object.freeze({
    ...next,
    revision: previous ? Math.max(next.revision, previous.revision + 1) : next.revision,
    counts: Object.freeze(next.counts),
  })
}
