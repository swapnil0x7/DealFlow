import { attentionFor } from '../../domain/attention'
import type { Attention } from '../../domain/attention'
import type { Deal, Owner } from '../../domain/deal'
import { CURRENT_OWNER_ID } from '../../domain/filters'

export interface PipelineRow {
  readonly deal: Deal
  readonly ownerName: string
  readonly searchName: string
  readonly attention: Attention | null
}

export function projectDeal(deal: Deal, owners: ReadonlyMap<string, string>, now: number): PipelineRow {
  return { deal, ownerName: owners.get(deal.ownerId) ?? 'Unknown owner', searchName: deal.companyName.toLowerCase(), attention: attentionFor(deal, now) }
}

export function projectPipeline(deals: readonly Deal[], owners: readonly Owner[], now: number) {
  const names = new Map(owners.map((owner) => [owner.id, owner.name]))
  let mine = 0
  let attention = 0
  const rows = deals.map((deal) => {
    const row = projectDeal(deal, names, now)
    if (deal.ownerId === CURRENT_OWNER_ID) mine++
    if (row.attention) attention++
    return row
  })
  return { rows, counts: { all: rows.length, mine, attention } }
}

type Counts = ReturnType<typeof projectPipeline>['counts']

/** Cached derived rows. Updates publish only changed rows; counters have a small external-store snapshot. */
export class PipelineProjection {
  readonly initialRows: PipelineRow[]
  private readonly byId: Map<string, PipelineRow>
  private readonly names: Map<string, string>
  private readonly now: number
  private counts: Counts
  private readonly rowListeners = new Set<(rows: PipelineRow[]) => void>()
  private readonly countListeners = new Set<() => void>()

  constructor(deals: readonly Deal[], owners: readonly Owner[], now: number) {
    const projection = projectPipeline(deals, owners, now)
    this.initialRows = projection.rows
    this.counts = projection.counts
    this.byId = new Map(this.initialRows.map((row) => [row.deal.id, row]))
    this.names = new Map(owners.map((owner) => [owner.id, owner.name]))
    this.now = now
  }

  getCounts = (): Counts => this.counts
  subscribeCounts = (listener: () => void): (() => void) => {
    this.countListeners.add(listener)
    return () => { this.countListeners.delete(listener) }
  }
  subscribeRows(listener: (rows: PipelineRow[]) => void): () => void {
    this.rowListeners.add(listener)
    return () => { this.rowListeners.delete(listener) }
  }

  apply(records: readonly Deal[]): void {
    const counts = { ...this.counts }
    const rows: PipelineRow[] = []
    for (const record of records) {
      const previous = this.byId.get(record.id)
      if (previous && previous.deal.version >= record.version) continue
      const row = projectDeal(record, this.names, this.now)
      this.byId.set(record.id, row)
      counts.all += previous ? 0 : 1
      counts.mine += Number(record.ownerId === CURRENT_OWNER_ID) - Number(previous?.deal.ownerId === CURRENT_OWNER_ID)
      counts.attention += Number(Boolean(row.attention)) - Number(Boolean(previous?.attention))
      rows.push(row)
    }
    if (!rows.length) return
    if (counts.all !== this.counts.all || counts.mine !== this.counts.mine || counts.attention !== this.counts.attention) {
      this.counts = counts
      this.countListeners.forEach((listener) => listener())
    }
    this.rowListeners.forEach((listener) => listener(rows))
  }
}
