import { complete, cooperate } from '../../shared/cooperative'
import { localDayWindow, updatedOnDay } from '../../domain/calendar'
import { createStore } from 'zustand/vanilla'
import { attentionFor } from '../../domain/attention'
import type { Deal, Owner } from '../../domain/deal'
import { STAGE_LABELS } from '../../domain/deal'
import { matchesFilters } from '../../domain/filters'
import type { PipelineFilters } from '../../domain/filters'
import type { ConfirmedReadModel } from '../collaboration/read-model'

export interface SelectionChange {
  readonly added: readonly string[]
  readonly removed: readonly string[]
}

interface SelectionState {
  count: number
  changed: number
  totalValuePaise: number
  source: PipelineFilters | null
  revision: number
  notice: string
}

export function describeCriteria(filters: PipelineFilters, owners: readonly Owner[]): string {
  return [
    filters.view === 'mine'
      ? 'My deals'
      : filters.view === 'today'
        ? 'Updated today (local calendar day)'
        : filters.view === 'attention'
          ? 'Needs attention'
          : 'All deals',
    filters.search && `company contains “${filters.search}”`,
    filters.ownerId &&
      `owner: ${owners.find((owner) => owner.id === filters.ownerId)?.name ?? filters.ownerId}`,
    filters.stage && `stage: ${STAGE_LABELS[filters.stage]}`,
  ]
    .filter(Boolean)
    .join(' · ')
}

/** Original immutable reviewed records, independent of grid mounting, sorting, refresh, and resync. */
export class SelectionService {
  readonly store = createStore<SelectionState>(() => ({
    count: 0,
    changed: 0,
    totalValuePaise: 0,
    source: null,
    revision: 0,
    notice: '',
  }))
  private selected = new Map<string, Deal>()
  private changed = new Set<string>()
  private readonly listeners = new Set<(change: SelectionChange) => void>()
  private totalValuePaise = 0
  private preparation: AbortController | null = null
  private pending: { selected: Map<string, Deal>; changed: Set<string> } | null = null
  private readonly unsubscribe: () => void
  private readonly model: ConfirmedReadModel

  constructor(model: ConfirmedReadModel) {
    this.model = model
    this.unsubscribe = model.subscribe((records) => {
      let changed = false
      records.forEach((record) => {
        const pending = this.pending?.selected.get(record.id)
        if (pending && pending.version !== record.version) this.pending?.changed.add(record.id)
        const reviewed = this.selected.get(record.id)
        if (reviewed && record.version !== reviewed.version && !this.changed.has(record.id)) {
          this.changed.add(record.id)
          changed = true
        }
      })
      if (changed) this.store.setState({ changed: this.changed.size })
    })
  }

  records(): readonly Deal[] {
    return Array.from(this.selected.values())
  }
  has(id: string): boolean {
    return this.selected.has(id)
  }
  isChanged(id: string): boolean {
    return this.changed.has(id)
  }
  subscribe(listener: (change: SelectionChange) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  dispose(): void {
    this.cancelPreparation()
    this.unsubscribe()
    this.listeners.clear()
  }

  /** One user gesture changes one member; existing members retain their captured versions. */
  setSelected(record: Deal, selected: boolean, source: PipelineFilters): void {
    this.cancelPreparation()
    if (this.selected.has(record.id) === selected) return
    if (selected) this.add(record)
    else this.remove(record.id)
    this.publish(source, '', {
      added: selected ? [record.id] : [],
      removed: selected ? [] : [record.id],
    })
  }

  setMembership(records: readonly Deal[], source: PipelineFilters): void {
    this.cancelPreparation()
    const ids = new Set(records.map((record) => record.id))
    const removed: string[] = []
    const added: string[] = []
    for (const id of this.selected.keys()) {
      if (!ids.has(id)) {
        this.remove(id)
        removed.push(id)
      }
    }
    for (const record of records) {
      if (!this.selected.has(record.id)) {
        this.add(record)
        added.push(record.id)
      }
    }
    if (added.length || removed.length) this.publish(source, '', { added, removed })
  }

  private add(record: Deal): void {
    this.selected.set(record.id, Object.freeze({ ...record }))
    this.totalValuePaise += record.valuePaise
    if (this.model.get(record.id)?.version !== record.version) this.changed.add(record.id)
  }

  private remove(id: string): void {
    this.totalValuePaise -= this.selected.get(id)!.valuePaise
    this.selected.delete(id)
    this.changed.delete(id)
  }

  private cancelPreparation(): void {
    this.preparation?.abort()
    this.preparation = null
    this.pending = null
  }

  selectMatching(filters: PipelineFilters, now: number): void {
    this.cancelPreparation()
    complete(this.matchingWork(filters, now))
  }

  async prepareMatching(filters: PipelineFilters, now: number, signal: AbortSignal): Promise<void> {
    this.cancelPreparation()
    const controller = new AbortController()
    this.preparation = controller
    const combined = AbortSignal.any([signal, controller.signal])
    try {
      await cooperate(this.matchingWork(filters, now), combined)
    } finally {
      if (this.preparation === controller) {
        this.preparation = null
        this.pending = null
      }
    }
  }

  private *matchingWork(filters: PipelineFilters, now: number): Generator<void, void, void> {
    // Read-model records are immutable. This array fixes membership/version inputs before yielding.
    const records = this.model.all()
    const day = localDayWindow(now)
    const selected = new Map<string, Deal>()
    const changed = new Set<string>()
    this.pending = { selected, changed }
    const added: string[] = []
    const removed: string[] = []
    let total = 0
    for (const deal of records) {
      if (
        matchesFilters(
          {
            deal,
            searchName: deal.companyName.toLowerCase(),
            attention: attentionFor(deal, now),
            updatedToday: updatedOnDay(deal, day),
          },
          filters,
        )
      ) {
        const reviewed = this.selected.get(deal.id) ?? deal
        selected.set(deal.id, reviewed)
        total += reviewed.valuePaise
        if (this.model.get(deal.id)?.version !== reviewed.version) changed.add(deal.id)
        if (!this.selected.has(deal.id)) added.push(deal.id)
      }
      yield
    }
    for (const id of this.selected.keys()) {
      if (!selected.has(id)) removed.push(id)
      yield
    }
    this.selected = selected
    this.changed = changed
    this.pending = null
    this.totalValuePaise = total
    this.publish(
      filters,
      'Selected the latest confirmed matching set. New matches will not join automatically.',
      { added, removed },
    )
  }

  clear(reason = 'Selection cleared.'): void {
    this.cancelPreparation()
    if (!this.selected.size) return
    const removed = Array.from(this.selected.keys())
    this.selected.clear()
    this.changed.clear()
    this.totalValuePaise = 0
    this.publish(null, reason, { added: [], removed })
  }

  private publish(source: PipelineFilters | null, notice: string, change: SelectionChange): void {
    this.store.setState((state) => ({
      count: this.selected.size,
      totalValuePaise: this.totalValuePaise,
      changed: this.changed.size,
      source: source ? Object.freeze({ ...source }) : null,
      revision: state.revision + 1,
      notice,
    }))
    this.listeners.forEach((listener) => listener(change))
  }
}
