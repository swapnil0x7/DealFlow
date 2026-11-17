import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { STAGES, STAGE_LABELS, isStage } from '../../domain/deal'
import { CURRENT_OWNER_ID, DEFAULT_FILTERS, normalizeSearch } from '../../domain/filters'
import type { PipelineFilters, WorkView } from '../../domain/filters'
import { formatCount } from '../../shared/format'
import { Dropdown } from '../../shared/ui/Dropdown'
import type { WorkspaceSession } from '../collaboration/session'
import { ConnectionStatus } from '../collaboration/ConnectionStatus'
import { SimulationPanel } from '../collaboration/SimulationPanel'
import { PipelineTable } from './PipelineTable'
import { AttentionHelp } from './AttentionHelp'
import { PipelineProjection } from './projection'
import { usePriorityClock } from './use-priority-clock'
import { ChangesProvider } from '../operations/ChangesProvider'
import { ChangesButton } from '../operations/ChangesButton'
import { ChangesNotice } from '../operations/ChangesNotice'
import styles from './Pipeline.module.css'
import { ThemeSwitcher } from '../theme/ThemeSwitcher'

const VIEWS: { id: WorkView; label: string }[] = [
  { id: 'all', label: 'All deals' },
  { id: 'mine', label: 'My deals' },
  { id: 'attention', label: 'Needs attention' },
]

export function PipelineWorkspace({
  session,
  onReset,
}: {
  session: WorkspaceSession
  onReset: (seed: number) => void
}) {
  return (
    <ChangesProvider operations={session.operations} bulk={session.bulk} model={session.model}>
      <WorkspaceContent session={session} onReset={onReset} />
    </ChangesProvider>
  )
}

function WorkspaceContent({
  session,
  onReset,
}: {
  session: WorkspaceSession
  onReset: (seed: number) => void
}) {
  const { model, operations, feed, selection, bulk } = session
  const owners = session.snapshot.owners
  const [activeDealId, setActiveDealId] = useState<string | null>(null)
  useEffect(() => {
    const visibility = () => feed.setVisible(!document.hidden)
    const online = () => {
      feed.setNetworkOnline(navigator.onLine)
    }
    const focus = () => feed.wake()
    visibility()
    online()
    const stop = feed.start()
    document.addEventListener('visibilitychange', visibility)
    window.addEventListener('online', online)
    window.addEventListener('offline', online)
    window.addEventListener('focus', focus)
    return () => {
      document.removeEventListener('visibilitychange', visibility)
      window.removeEventListener('online', online)
      window.removeEventListener('offline', online)
      window.removeEventListener('focus', focus)
      stop()
    }
  }, [feed])
  const [filters, setFilters] = useState<PipelineFilters>(DEFAULT_FILTERS)
  const [search, setSearch] = useState('')
  const previousFilters = useRef(filters)
  useEffect(() => {
    const previous = previousFilters.current
    if (
      previous.view !== filters.view ||
      previous.search !== filters.search ||
      previous.ownerId !== filters.ownerId ||
      previous.stage !== filters.stage
    )
      selection.clear('Filters changed. Selection cleared.')
    previousFilters.current = filters
  }, [filters, selection])
  const [openedAt] = useState(Date.now)
  const [listRefreshReason, setListRefreshReason] = useState<'records' | 'time' | null>(null)
  const listStale = listRefreshReason !== null
  const [matching, setMatching] = useState(model.size)
  const [sortDescription, setSortDescription] = useState('Company ascending')
  const searchRef = useRef<HTMLInputElement>(null)
  const projection = useMemo(
    () => new PipelineProjection(model.all(), owners, openedAt),
    [model, owners, openedAt],
  )
  const counts = useSyncExternalStore(projection.subscribeCounts, projection.getCounts)
  useEffect(() => model.subscribe((records) => projection.apply(records)), [model, projection])
  usePriorityClock(projection)
  const currentOwner = owners.find((owner) => owner.id === CURRENT_OWNER_ID)
  const searching = normalizeSearch(search) !== filters.search
  const hasFilters = Boolean(search || filters.ownerId || filters.stage)

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const value = normalizeSearch(search)
      setFilters((current) => (current.search === value ? current : { ...current, search: value }))
    }, 200)
    return () => window.clearTimeout(timer)
  }, [search])

  function clearFilters() {
    selection.clear('Filters changed. Selection cleared.')
    setSearch('')
    setFilters((current) => ({ ...DEFAULT_FILTERS, view: current.view }))
  }

  return (
    <div data-pipeline-workspace className={styles.workspace}>
      <a className={styles.skipLink} href="#pipeline-workspace">
        Skip to pipeline
      </a>
      <header className={styles.header}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden="true">
            D
          </span>
          <span>
            DealDesk
            <span className={styles.brandSubtitle}>Sales workspace</span>
          </span>
        </div>
        <div className={styles.headerControls}>
          <ConnectionStatus feed={feed} />
          <ChangesButton />
          <SimulationPanel session={session} activeDealId={activeDealId} onReset={onReset} />
          <ThemeSwitcher />
          <div className={styles.identity}>
            <span className={styles.avatar} aria-hidden="true">
              AS
            </span>
            <span>
              {currentOwner?.name ?? 'Your workspace'}
              <small>My workspace</small>
            </span>
          </div>
        </div>
      </header>
      <ChangesNotice />
      <main id="pipeline-workspace" className={styles.main} tabIndex={-1}>
        <div className={styles.titleRow}>
          <div>
            <p className={styles.eyebrow}>Your daily sales desk</p>
            <h1>Sales pipeline</h1>
            <p className={styles.subtitle}>
              Find the deals that need you. Keep every opportunity in view.
            </p>
          </div>
          <div className={styles.totals} aria-label="Pipeline summary">
            <strong>
              {formatCount(model.size)}
              <span>total deals</span>
            </strong>
            <strong>
              {owners.length}
              <span>salespeople</span>
            </strong>
          </div>
        </div>

        <section className={styles.panel} aria-label="Pipeline workspace">
          <div className={styles.views} role="group" aria-label="Work views">
            {VIEWS.map((view) => (
              <button
                key={view.id}
                type="button"
                aria-pressed={filters.view === view.id}
                onClick={() => {
                  if (filters.view !== view.id)
                    selection.clear('Work view changed. Selection cleared.')
                  setFilters((current) => ({ ...current, view: view.id }))
                }}
              >
                {view.label}
                <span>{formatCount(counts[view.id])}</span>
              </button>
            ))}
          </div>
          <div className={styles.toolbar} role="search" aria-label="Filter deals">
            <label className={styles.search}>
              <span>Search company</span>
              <span className={styles.searchField}>
                <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                  <circle cx="8.5" cy="8.5" r="5.5" />
                  <path d="m13 13 4 4" />
                </svg>
                <input
                  ref={searchRef}
                  id="company-search"
                  type="search"
                  value={search}
                  placeholder="Search by company name…"
                  onChange={(event) => {
                    selection.clear('Search changed. Selection cleared.')
                    setSearch(event.target.value)
                  }}
                />
              </span>
            </label>
            <label>
              <span>Owner</span>
              <Dropdown
                aria-label="Owner"
                size="filter"
                value={filters.ownerId}
                options={[
                  { value: '', label: 'All owners' },
                  ...owners.map((owner) => ({
                    value: owner.id,
                    label: owner.name,
                  })),
                ]}
                onValueChange={(ownerId) => {
                  selection.clear('Owner filter changed. Selection cleared.')
                  setFilters((current) => ({
                    ...current,
                    ownerId,
                  }))
                }}
              />
            </label>
            <label>
              <span>Stage</span>
              <Dropdown
                aria-label="Stage"
                size="filter"
                value={filters.stage}
                options={[
                  { value: '', label: 'All stages' },
                  ...STAGES.map((stage) => ({
                    value: stage,
                    label: STAGE_LABELS[stage],
                  })),
                ]}
                onValueChange={(stage) => {
                  selection.clear('Stage filter changed. Selection cleared.')
                  if (stage === '' || isStage(stage))
                    setFilters((current) => ({ ...current, stage }))
                }}
              />
            </label>
            <button
              type="button"
              className={styles.clear}
              disabled={!hasFilters}
              onClick={clearFilters}
            >
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M4 7a6 6 0 1 1-.5 5M4 3v4h4" />
              </svg>
              Clear filters
            </button>
          </div>
          <div className={styles.listSummary}>
            <p role="status" aria-live="polite" aria-atomic="true" data-testid="matching-count">
              {searching ? (
                'Searching…'
              ) : (
                <>
                  <strong>{formatCount(matching)}</strong>{' '}
                  {listStale ? 'displayed deals' : 'matching deals'}
                </>
              )}
            </p>
            <AttentionHelp />
          </div>
          <PipelineTable
            projection={projection}
            onActiveDealChange={setActiveDealId}
            operations={operations}
            selection={selection}
            bulk={bulk}
            owners={owners}
            searching={searching}
            filters={filters}
            listRefreshReason={listRefreshReason}
            onCountChange={setMatching}
            onSortChange={setSortDescription}
            onStaleChange={setListRefreshReason}
          />
          <footer className={styles.footer}>
            <p id="pipeline-keyboard-help" className={styles.srOnly}>
              Arrows navigate · Tab reaches actions · Space selects a row · Enter/F2 edits stage ·
              Escape cancels · End for last row
            </p>
            <div className={styles.keyboardHints} aria-hidden="true">
              <span>
                <kbd>↑ ↓</kbd> Navigate
              </span>
              <span>
                <kbd>Enter</kbd> Edit stage
              </span>
              <span>
                <kbd>Space</kbd> Select
              </span>
            </div>
            <p className={styles.sortInfo}>
              Sorted by <strong>{sortDescription}</strong>
            </p>
            <a className={styles.backToFilters} href="#company-search">
              <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path d="M8 13V3m-4 4 4-4 4 4" />
              </svg>
              Back to filters
            </a>
          </footer>
        </section>
        <p className={styles.footnote}>
          Customer activity dates stay independent of stage changes.
        </p>
      </main>
    </div>
  )
}
