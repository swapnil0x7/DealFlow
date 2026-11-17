import type { Stage } from '../../domain/deal'
import type { ItemState } from './service'

export interface CommandActivity {
  readonly id: string
  readonly dealId: string
  readonly stage: Stage
  readonly kind: 'move' | 'undo'
  readonly status: ItemState
  readonly resolution?: 'kept' | 'replaced'
}

export const isUnresolved = (status: ItemState) => status === 'queued' || status === 'saving' || status === 'unconfirmed'

/** Shared local write guards and small per-deal subscriptions for both command workflows. */
export class ActivityRegistry {
  private readonly byDeal = new Map<string, Map<string, CommandActivity>>()
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly dirty = new Set<string>()
  private batching = 0

  get(dealId: string): CommandActivity | undefined {
    let latest: CommandActivity | undefined
    let pending: CommandActivity | undefined
    this.byDeal.get(dealId)?.forEach((item) => { latest = item; if (isUnresolved(item.status)) pending = item })
    return pending ?? latest
  }

  isBlocked(dealId: string, exceptId?: string): boolean {
    for (const item of this.byDeal.get(dealId)?.values() ?? []) {
      if (item.id !== exceptId && isUnresolved(item.status)) return true
    }
    return false
  }

  claim(item: CommandActivity): boolean {
    if (this.isBlocked(item.dealId, item.id)) return false
    this.update(item)
    return true
  }

  update(item: CommandActivity): void {
    let entries = this.byDeal.get(item.dealId)
    if (!entries) { entries = new Map(); this.byDeal.set(item.dealId, entries) }
    // An explicit retry is current activity even when its command was created before a later resolved command.
    // Late terminal receipts do not move old commands ahead of newer activity.
    if (item.status === 'queued' || item.status === 'saving') entries.delete(item.id)
    entries.set(item.id, Object.freeze({ ...item }))
    this.changed(item.dealId)
  }

  remove(dealId: string, id: string): void {
    const entries = this.byDeal.get(dealId)
    entries?.delete(id)
    if (!entries?.size) this.byDeal.delete(dealId)
    this.changed(dealId)
  }

  subscribe(dealId: string, listener: () => void): () => void {
    let listeners = this.listeners.get(dealId)
    if (!listeners) { listeners = new Set(); this.listeners.set(dealId, listeners) }
    listeners.add(listener)
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(dealId) }
  }

  batch<T>(work: () => T): T {
    this.batching++
    try { return work() } finally {
      if (--this.batching === 0) {
        const dirty = Array.from(this.dirty)
        this.dirty.clear()
        dirty.forEach((id) => this.listeners.get(id)?.forEach((listener) => listener()))
      }
    }
  }

  private changed(id: string): void {
    if (this.batching) this.dirty.add(id)
    else this.listeners.get(id)?.forEach((listener) => listener())
  }
}
