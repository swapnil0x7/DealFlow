import type { Deal } from '../../domain/deal'

type Listener = (changed: readonly Deal[]) => void

/** Confirmed client snapshots only. The server repository remains authoritative. */
export class ConfirmedReadModel {
  private readonly records = new Map<string, Deal>()
  private readonly listeners = new Set<Listener>()
  private cachedRecords: readonly Deal[] | undefined

  constructor(records: readonly Deal[]) {
    this.apply(records)
  }

  get size(): number {
    return this.records.size
  }
  get(id: string): Deal | undefined {
    return this.records.get(id)
  }

  all(): readonly Deal[] {
    this.cachedRecords ??= Object.freeze(Array.from(this.records.values()))
    return this.cachedRecords
  }

  apply(incoming: readonly Deal[]): readonly Deal[] {
    const changed = new Map<string, Deal>()
    for (const record of incoming) {
      const current = this.records.get(record.id)
      if (current && current.version >= record.version) continue
      const snapshot = Object.freeze({ ...record })
      this.records.set(record.id, snapshot)
      changed.set(record.id, snapshot)
    }
    if (!changed.size) return []
    this.cachedRecords = undefined
    const updates = Object.freeze(Array.from(changed.values()))
    this.listeners.forEach((listener) => listener(updates))
    return updates
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}
