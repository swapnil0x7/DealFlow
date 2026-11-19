import { localDayWindow, updatedOnDay } from '../../domain/calendar'
import type { DayWindow } from '../../domain/calendar'
import { attentionFor } from '../../domain/attention'
import type { Attention } from '../../domain/attention'
import type { Deal, Owner } from '../../domain/deal'
import { CURRENT_OWNER_ID } from '../../domain/filters'

export interface PipelineRow {
  readonly deal: Deal
  readonly ownerName: string
  readonly searchName: string
  readonly attention: Attention | null
  readonly updatedToday: boolean
}

export function projectDeal(
  deal: Deal,
  owners: ReadonlyMap<string, string>,
  now: number,
  day: DayWindow = localDayWindow(now),
): PipelineRow {
  return {
    deal,
    ownerName: owners.get(deal.ownerId) ?? 'Unknown owner',
    searchName: deal.companyName.toLowerCase(),
    attention: attentionFor(deal, now),
    updatedToday: updatedOnDay(deal, day),
  }
}

export function projectPipeline(deals: readonly Deal[], owners: readonly Owner[], now: number) {
  const names = new Map(owners.map((owner) => [owner.id, owner.name]))
  const day = localDayWindow(now)
  let today = 0
  let mine = 0
  let attention = 0
  const rows = deals.map((deal) => {
    const row = projectDeal(deal, names, now, day)
    if (deal.ownerId === CURRENT_OWNER_ID) mine++
    if (row.attention) attention++
    if (row.updatedToday) today++
    return row
  })
  return { rows, counts: { all: rows.length, mine, attention, today } }
}

type Counts = ReturnType<typeof projectPipeline>['counts']

/** Cached derived rows. Updates publish only changed rows; counters have a small external-store snapshot. */
export class PipelineProjection {
  readonly initialRows: PipelineRow[]
  private readonly byId: Map<string, PipelineRow>
  private readonly names: Map<string, string>
  private now: number
  private day: DayWindow
  private counts: Counts
  private readonly rowListeners = new Set<
    (rows: PipelineRow[], source: 'records' | 'time') => void
  >()
  private readonly countListeners = new Set<() => void>()

  constructor(deals: readonly Deal[], owners: readonly Owner[], now: number) {
    const projection = projectPipeline(deals, owners, now)
    this.initialRows = projection.rows
    this.counts = projection.counts
    this.byId = new Map(this.initialRows.map((row) => [row.deal.id, row]))
    this.names = new Map(owners.map((owner) => [owner.id, owner.name]))
    this.now = now
    this.day = localDayWindow(now)
  }

  getCounts = (): Counts => this.counts
  get evaluationTime(): number {
    return this.now
  }
  subscribeCounts = (listener: () => void): (() => void) => {
    this.countListeners.add(listener)
    return () => {
      this.countListeners.delete(listener)
    }
  }
  subscribeRows(listener: (rows: PipelineRow[], source: 'records' | 'time') => void): () => void {
    this.rowListeners.add(listener)
    return () => {
      this.rowListeners.delete(listener)
    }
  }

  apply(records: readonly Deal[]): void {
    const counts = { ...this.counts }
    const rows: PipelineRow[] = []
    for (const record of records) {
      const previous = this.byId.get(record.id)
      if (previous && previous.deal.version >= record.version) continue
      const row = projectDeal(record, this.names, this.now, this.day)
      this.byId.set(record.id, row)
      counts.all += previous ? 0 : 1
      counts.mine +=
        Number(record.ownerId === CURRENT_OWNER_ID) -
        Number(previous?.deal.ownerId === CURRENT_OWNER_ID)
      counts.attention += Number(Boolean(row.attention)) - Number(Boolean(previous?.attention))
      counts.today += Number(row.updatedToday) - Number(Boolean(previous?.updatedToday))
      rows.push(row)
    }
    if (!rows.length) return
    if (
      counts.all !== this.counts.all ||
      counts.mine !== this.counts.mine ||
      counts.attention !== this.counts.attention ||
      counts.today !== this.counts.today
    ) {
      this.counts = counts
      this.countListeners.forEach((listener) => listener())
    }
    this.rowListeners.forEach((listener) => listener(rows, 'records'))
  }

  /** Reuse the projection and record snapshots; only changed attention fields are published. */
  refreshTime(now: number): void {
    if (now === this.now) return
    this.now = now
    const day = localDayWindow(now)
    const dayChanged = day.start !== this.day.start || day.end !== this.day.end
    this.day = day
    const rows: PipelineRow[] = []
    let attentionCount = this.counts.attention
    let todayCount = this.counts.today
    for (const previous of this.byId.values()) {
      const attention = attentionFor(previous.deal, now)
      const updatedToday = dayChanged
        ? updatedOnDay(previous.deal, this.day)
        : previous.updatedToday
      if (
        updatedToday === previous.updatedToday &&
        attention?.urgency === previous.attention?.urgency &&
        attention?.baseline === previous.attention?.baseline &&
        attention?.reason === previous.attention?.reason
      )
        continue
      const row = { ...previous, attention, updatedToday }
      this.byId.set(row.deal.id, row)
      rows.push(row)
      attentionCount += Number(Boolean(attention)) - Number(Boolean(previous.attention))
      todayCount += Number(updatedToday) - Number(previous.updatedToday)
    }
    if (attentionCount !== this.counts.attention || todayCount !== this.counts.today) {
      this.counts = { ...this.counts, attention: attentionCount, today: todayCount }
      this.countListeners.forEach((listener) => listener())
    }
    if (rows.length) this.rowListeners.forEach((listener) => listener(rows, 'time'))
  }
}
