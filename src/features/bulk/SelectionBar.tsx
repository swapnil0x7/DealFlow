import { usePreparation } from '../../shared/use-preparation'
import { Button } from '../../shared/ui/Button'
import { useEffect, useRef, useState } from 'react'
import { useStore } from 'zustand'
import { STAGES, STAGE_LABELS, isStage } from '../../domain/deal'
import type { Owner, Stage } from '../../domain/deal'
import type { PipelineFilters } from '../../domain/filters'
import { formatCount, formatMoney } from '../../shared/format'
import { Dropdown } from '../../shared/ui/Dropdown'
import type { BulkService } from './service'
import { describeCriteria } from './selection'
import type { SelectionService } from './selection'
import type { BulkPreview } from './types'
import { BulkReview } from './BulkReview'
import { BulkProgress } from './BulkProgress'
import styles from './Bulk.module.css'

export function SelectionBar({
  selection,
  service,
  filters,
  owners,
  stale,
  searching,
  onSelectAll,
}: {
  selection: SelectionService
  service: BulkService
  filters: PipelineFilters
  owners: readonly Owner[]
  stale: boolean
  searching: boolean
  onSelectAll: (signal: AbortSignal) => Promise<void>
}) {
  const preparation = usePreparation()
  const { cancel } = preparation
  const state = useStore(selection.store)
  const expired = useStore(service.store, (value) => value.expired)
  const [target, setTarget] = useState<Stage>('contacted')
  useEffect(() => cancel, [filters, target, state.revision, cancel])
  const [preview, setPreview] = useState<BulkPreview | null>(null)
  const trigger = useRef<HTMLElement | null>(null)
  const fallback = useRef<HTMLButtonElement>(null)
  return (
    <div
      className={styles.selectionBar}
      data-selected={state.count > 0}
      aria-label="Bulk selection"
    >
      <div className={styles.selectionTop}>
        <div className={styles.selectionSummary}>
          {state.count > 0 && (
            <span className={styles.selectionIcon} aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none">
                <path d="m6 12 4 4 8-8" />
              </svg>
            </span>
          )}
          <div
            className={styles.selectionTotals}
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-testid="selection-count"
          >
            <strong>{formatCount(state.count)} selected</strong>
            {state.count > 0 && (
              <span className={styles.selectionValue}>
                {formatMoney(state.totalValuePaise)} <span>reviewed value</span>
              </span>
            )}
            {state.changed > 0 && (
              <span className={styles.changed}>
                {formatCount(state.changed)} changed since selection
              </span>
            )}
            {state.count === 0 && state.notice && (
              <span className={styles.selectionNotice}>{state.notice}</span>
            )}
          </div>
        </div>
        {state.count > 0 && (
          <div className={styles.bulkMoveActions}>
            <label className={styles.targetStage}>
              <span>Move selected deals to</span>
              <Dropdown
                aria-label="Bulk target stage"
                value={target}
                options={STAGES.map((stage) => ({ value: stage, label: STAGE_LABELS[stage] }))}
                onValueChange={(stage) => {
                  if (isStage(stage)) setTarget(stage)
                }}
              />
            </label>
            <Button
              className={styles.reviewButton}
              disabled={searching || expired}
              aria-disabled={searching || expired || preparation.busy}
              onClick={(event) => {
                if (preparation.busy) return
                trigger.current = event.currentTarget
                const records = selection.records()
                const source = describeCriteria(state.source ?? filters, owners)
                void preparation
                  .run((signal) => service.preparePreview(records, target, source, signal))
                  .then((value) => {
                    if (value) setPreview(value)
                  })
              }}
            >
              Review bulk move
              <svg viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M4 10h12m-5-5 5 5-5 5" />
              </svg>
            </Button>
          </div>
        )}
      </div>
      <div className={styles.selectionFooter}>
        <div className={styles.selectionUtilities}>
          <Button
            ref={fallback}
            disabled={searching || expired}
            aria-disabled={searching || expired || preparation.busy}
            onClick={() => {
              if (!preparation.busy) void preparation.run(onSelectAll)
            }}
          >
            {stale ? 'Refresh list and select all matching' : 'Select all matching'}
          </Button>
          {state.count > 0 && (
            <Button
              onClick={() => {
                preparation.cancel()
                selection.clear()
                fallback.current?.focus()
              }}
            >
              Clear selection
            </Button>
          )}
        </div>
        {state.count > 0 && (
          <details className={styles.selectionHelp}>
            <summary>Selection details</summary>
            <div>
              {state.notice && <p>{state.notice}</p>}
              <p>
                Sorting and Refresh keep the versions you selected. Deselect and reselect a changed
                deal to accept its latest version.
              </p>
            </div>
          </details>
        )}
      </div>
      {preparation.busy && (
        <p role="status">
          Preparing selection or review…{' '}
          <Button onClick={preparation.cancel}>Cancel preparation</Button>
        </p>
      )}
      {preparation.error && <p role="alert">{preparation.error}</p>}
      <BulkProgress />
      <BulkReview
        preview={preview}
        service={service}
        onClose={() => setPreview(null)}
        trigger={trigger}
        fallback={fallback}
      />
    </div>
  )
}
