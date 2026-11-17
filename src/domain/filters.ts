import type { Deal, Stage } from './deal'
import type { Attention } from './attention'

export type WorkView = 'all' | 'mine' | 'attention'
export interface PipelineFilters {
  readonly view: WorkView
  readonly search: string
  readonly ownerId: string
  readonly stage: Stage | ''
}

export const CURRENT_OWNER_ID = 'owner-1'
export const DEFAULT_FILTERS: PipelineFilters = {
  view: 'all',
  search: '',
  ownerId: '',
  stage: '',
}

export interface FilterableDeal {
  readonly deal: Deal
  readonly attention: Attention | null
  readonly searchName: string
}

export function normalizeSearch(search: string): string {
  return search.trim().toLowerCase()
}

/** Shared by grid membership and future selection snapshots; never depends on mounted rows. */
export function matchesFilters(
  row: FilterableDeal,
  filters: PipelineFilters,
  currentOwnerId = CURRENT_OWNER_ID,
): boolean {
  return (
    (filters.view !== 'mine' || row.deal.ownerId === currentOwnerId) &&
    (filters.view !== 'attention' || row.attention !== null) &&
    (!filters.ownerId || row.deal.ownerId === filters.ownerId) &&
    (!filters.stage || row.deal.stage === filters.stage) &&
    (!filters.search || row.searchName.includes(normalizeSearch(filters.search)))
  )
}
