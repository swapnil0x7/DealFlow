import { Button } from '../../shared/ui/Button'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { usePreparation } from '../../shared/use-preparation'
import { useAnnouncement } from '../../shared/use-announcement'
import { useStore } from 'zustand'
import { STAGE_LABELS } from '../../domain/deal'
import { formatCount } from '../../shared/format'
import { Dropdown } from '../../shared/ui/Dropdown'
import type { ConfirmedReadModel } from '../collaboration/read-model'
import type { ItemState } from '../../domain/command'
import { RESULT_LABELS } from '../operations/presentation'
import type { BulkService } from './service'
import { ITEM_STATES } from './types'
import type { BulkItem, BulkPreview, BulkSummary } from './types'
import { BulkReview } from './BulkReview'
import { useChanges } from '../operations/changes-context'
import styles from './Bulk.module.css'

const LABELS = { ...RESULT_LABELS, skipped: 'Skipped' }
const PAGE_SIZE = 30

function Item({
  item,
  onReview,
}: {
  item: BulkItem
  onReview: (item: BulkItem, trigger: HTMLElement) => void
}) {
  return (
    <li className={styles.item} data-testid="bulk-item" data-state={item.status} tabIndex={-1}>
      <div className={styles.itemHeading}>
        <strong>{item.companyName}</strong>
        <span>{LABELS[item.status]}</span>
      </div>
      <p>
        {STAGE_LABELS[item.previousStage]} → {STAGE_LABELS[item.command.stage]} · reviewed version{' '}
        {item.command.expectedVersion} · attempts {item.attempts}
      </p>
      {(item.skipReason || item.message || item.error) && (
        <p>{item.skipReason ?? item.message ?? item.error?.message}</p>
      )}
      {item.reviewedBy && (
        <p>Reviewed replacement submitted as a separate operation. Original conflict retained.</p>
      )}
      {item.undoId && <p>Undo submitted as a separate operation. Original success retained.</p>}
      {item.keptVersion !== undefined && (
        <p>Latest saved stage kept (version {item.keptVersion}).</p>
      )}
      {item.status === 'conflicted' && !item.reviewedBy && item.keptVersion === undefined && (
        <Button onClick={(event) => onReview(item, event.currentTarget)}>
          Review bulk conflict
        </Button>
      )}
      {item.history.length > 0 && (
        <details>
          <summary>Attempt history</summary>
          {item.olderAttempts > 0 && (
            <p>
              {item.olderAttempts} older outcomes compacted. Original command and total attempts
              retained.
            </p>
          )}
          <ul>
            {item.history.map((attempt, index) => (
              <li key={index}>
                Attempt {attempt.attempt}: {LABELS[attempt.status]}
                {attempt.message && ` · ${attempt.message}`}
              </li>
            ))}
          </ul>
        </details>
      )}
    </li>
  )
}

const GroupResults = memo(function GroupResults({
  summary,
  service,
  online,
  expired,
  onReview,
  onUndo,
  onDismiss,
}: {
  summary: BulkSummary
  service: BulkService
  online: boolean
  expired: boolean
  onReview: (groupId: string, item: BulkItem, trigger: HTMLElement) => void
  onUndo: (groupId: string, trigger: HTMLElement) => void
  onDismiss: () => void
}) {
  const [filter, setFilter] = useState<ItemState | 'all'>('all')
  const [page, setPage] = useState(0)
  const count = filter === 'all' ? summary.total : summary.counts[filter]
  const maxPage = Math.max(0, Math.ceil(count / PAGE_SIZE) - 1)
  const currentPage = Math.min(page, maxPage)
  const items = service.page(summary.id, filter, currentPage, PAGE_SIZE)
  const undoCount = summary.counts.succeeded > 0 ? service.undoEligible(summary.id) : 0
  const result = useRef<HTMLElement>(null)
  const action = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (action.current && !action.current.isConnected && document.activeElement === document.body)
      result.current?.focus()
  }, [summary])
  return (
    <article
      ref={result}
      className={styles.operation}
      tabIndex={-1}
      aria-label={`${summary.kind === 'undo' ? 'Bulk Undo' : 'Bulk move'} ${summary.id.slice(0, 8)}`}
      data-testid="bulk-operation"
    >
      <h3>
        {summary.kind === 'undo' ? 'Bulk Undo' : 'Bulk move'} · {formatCount(summary.total)} deals ·{' '}
        {summary.target ? STAGE_LABELS[summary.target] : 'Previous stages'}
      </h3>
      <p>
        {summary.source}
        {summary.parentId && ` · Linked to operation ${summary.parentId.slice(0, 8)}`}
      </p>
      <div className={styles.summary} data-testid="bulk-counts">
        {ITEM_STATES.map((state) => (
          <span key={state} data-state={state}>
            {LABELS[state]}: <strong>{formatCount(summary.counts[state])}</strong>
          </span>
        ))}
      </div>
      {(summary.message || summary.paused) && (
        <p className={styles.message}>
          {summary.message || 'Paused. Reconnect and explicitly resume queued work.'}
        </p>
      )}
      <div className={styles.actions}>
        {!expired && summary.counts.queued > 0 && summary.paused && (
          <Button
            disabled={!online}
            onClick={(event) => {
              action.current = event.currentTarget
              service.resume(summary.id)
            }}
          >
            Resume queued work
          </Button>
        )}
        {!expired && summary.retryable > 0 && (
          <Button
            disabled={!online || (summary.paused && summary.counts.queued > 0)}
            onClick={(event) => {
              action.current = event.currentTarget
              service.retryFailed(summary.id)
            }}
          >
            Retry eligible failed items
          </Button>
        )}
        {!expired && summary.counts.unconfirmed > 0 && (
          <>
            <Button
              disabled={!online || summary.checking}
              onClick={(event) => {
                action.current = event.currentTarget
                void service.reconcile(summary.id)
              }}
            >
              {summary.checking ? 'Checking bulk receipts…' : 'Check unconfirmed items'}
            </Button>
            {summary.resumable > 0 && (
              <Button
                disabled={
                  !online || summary.checking || (summary.paused && summary.counts.queued > 0)
                }
                onClick={(event) => {
                  action.current = event.currentTarget
                  service.retryChecked(summary.id)
                }}
              >
                Retry checked originals
              </Button>
            )}
          </>
        )}
        {!expired && undoCount > 0 && (
          <Button disabled={!online} onClick={(event) => onUndo(summary.id, event.currentTarget)}>
            Review Undo for {formatCount(undoCount)} successes
          </Button>
        )}
        {service.canDismiss(summary.id) && (
          <Button
            title="Removes this operation’s results, recovery, and Undo actions"
            onClick={() => {
              service.dismiss(summary.id)
              onDismiss()
            }}
          >
            Dismiss bulk results
          </Button>
        )}
      </div>
      <div className={styles.pagination}>
        <label>
          Inspect results{' '}
          <Dropdown<ItemState | 'all'>
            aria-label={`Inspect results ${summary.id.slice(0, 8)}`}
            value={filter}
            options={[
              { value: 'all', label: `All (${formatCount(summary.total)})` },
              ...ITEM_STATES.map((state) => ({
                value: state,
                label: `${LABELS[state]} (${formatCount(summary.counts[state])})`,
              })),
            ]}
            onValueChange={(state) => {
              setFilter(state)
              setPage(0)
            }}
          />
        </label>
        <span>
          {count
            ? `${formatCount(currentPage * PAGE_SIZE + 1)}–${formatCount(Math.min((currentPage + 1) * PAGE_SIZE, count))} of ${formatCount(count)}`
            : 'No results in this state'}
        </span>
        <Button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
          Previous results
        </Button>
        <Button disabled={currentPage >= maxPage} onClick={() => setPage(currentPage + 1)}>
          Next results
        </Button>
      </div>
      <ul className={styles.itemList}>
        {items.map((item) => (
          <Item
            key={item.command.mutationId}
            item={item}
            onReview={(entry, trigger) => onReview(summary.id, entry, trigger)}
          />
        ))}
      </ul>
    </article>
  )
})

export function BulkResults({
  service,
  model,
  embedded = false,
  groupId,
  needsActionOnly = false,
}: {
  service: BulkService
  model: ConfirmedReadModel
  embedded?: boolean
  groupId?: string
  needsActionOnly?: boolean
}) {
  const { controller } = useChanges()
  const preparation = usePreparation()
  const { run: prepare } = preparation
  const { groups, notice, online, expired } = useStore(service.store)
  const [preview, setPreview] = useState<BulkPreview | null>(null)
  const visibleGroups = groups.filter(
    (group) => (!groupId || group.id === groupId) && (!needsActionOnly || group.needsAction > 0),
  )
  const trigger = useRef<HTMLElement | null>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const onDismiss = useCallback(() => {
    if (groupId) controller.open({ kind: 'history', filter: 'all' })
    else heading.current?.focus()
  }, [controller, groupId])
  const onUndo = useCallback(
    (id: string, button: HTMLElement) => {
      trigger.current = button
      void prepare((signal) => service.prepareUndo(id, undefined, signal)).then((value) => {
        if (value) setPreview(value)
      })
    },
    [service, prepare],
  )
  const onReview = useCallback(
    (_groupId: string, item: BulkItem, button: HTMLElement) => {
      const record = model.get(item.command.dealId) ?? item.conflict!
      controller.open({ kind: 'bulk-item', id: item.command.mutationId, reviewed: record }, button)
    },
    [controller, model],
  )
  const totals = groups.reduce(
    (counts, group) => {
      ITEM_STATES.forEach((state) => {
        counts[state] += group.counts[state]
      })
      return counts
    },
    { queued: 0, saving: 0, succeeded: 0, failed: 0, conflicted: 0, unconfirmed: 0, skipped: 0 },
  )
  const announcement = useAnnouncement(
    groups.length
      ? ITEM_STATES.map(
          (state) => `${formatCount(totals[state])} ${LABELS[state].toLowerCase()}`,
        ).join(', ')
      : '',
  )

  return (
    <section
      className={`${styles.panel} ${embedded ? styles.embedded : ''}`}
      aria-label="Bulk results"
    >
      <h2 ref={heading} tabIndex={-1}>
        Bulk operations
      </h2>
      <p role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
      {notice && <p role="alert">{notice}</p>}
      {preparation.busy && (
        <p role="status">
          Preparing Undo review… <Button onClick={preparation.cancel}>Cancel preparation</Button>
        </p>
      )}
      {preparation.error && <p role="alert">{preparation.error}</p>}
      {expired && (
        <p role="alert">
          This simulation session expired. Reload the workspace before starting more changes.
        </p>
      )}
      <p>
        Each selected item has one current state. Retry retains its original command. Undo has
        separate results. Up to 10 operations / 100,000 item details are kept; dismissing removes
        recovery and Undo actions.
      </p>
      {!visibleGroups.length && (
        <p>
          Select deals with their checkboxes or Space, or select all matching, then review a bulk
          move.
        </p>
      )}
      {visibleGroups.map((summary) => (
        <GroupResults
          key={summary.id}
          summary={summary}
          service={service}
          online={online}
          expired={expired}
          onDismiss={onDismiss}
          onUndo={onUndo}
          onReview={onReview}
        />
      ))}
      <BulkReview
        preview={preview}
        service={service}
        onClose={() => setPreview(null)}
        trigger={trigger}
        fallback={heading}
        onSubmitted={(id) => {
          if (groupId) controller.open({ kind: 'bulk-group', id })
        }}
      />
    </section>
  )
}
