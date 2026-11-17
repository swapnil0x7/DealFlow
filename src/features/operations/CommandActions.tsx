import { useEffect, useRef } from 'react'
import type { PointerEvent, KeyboardEvent, MouseEvent } from 'react'
import { STAGE_LABELS } from '../../domain/deal'
import { useChanges } from './changes-context'
import { useCommand } from './use-command'
import { resolution } from './outcomes'
import styles from './Changes.module.css'

export function CommandActions({ id, dealId, mode = 'row' }: { id: string; dealId: string; mode?: 'row' | 'history' | 'detail' }) {
  const { operations, bulk, controller } = useChanges()
  const { item, single, latest, blocked, expired, online, groupId } = useCommand(id, dealId)
  const action = useRef<HTMLElement | null>(null)
  const fallback = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (action.current && !action.current.isConnected) {
      if (document.activeElement === document.body && fallback.current?.isConnected)
        fallback.current.focus({ preventScroll: true })
      action.current = null
    }
  }, [item])
  if (!item) return null
  const inline = mode === 'row'
  const unavailable = expired || blocked || (!single && !online)
  const handled = resolution(item)
  const review = item.status === 'conflicted' && !handled
  const undoable = single ? operations.canUndo(id) : bulk.canUndoItem(id)
  const begin = (element: HTMLElement) => {
    action.current = element
    fallback.current = element.closest<HTMLElement>('[role="gridcell"], [data-testid="operation-result"], [data-command-detail]')
  }
  const details = (element: HTMLElement) => {
    controller.open({ kind: single ? 'single' : 'bulk-item', id, reviewed: review ? latest ?? item.conflict : undefined }, element)
  }
  const buttonProps = {
    type: 'button' as const, 'data-recovery-for': id, tabIndex: inline ? -1 : 0,
    onPointerDown: (event: PointerEvent) => event.stopPropagation(),
    onMouseDown: (event: MouseEvent) => event.stopPropagation(),
    onKeyDown: (event: KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation() },
  }
  return <div className={inline ? styles.rowActions : styles.actions} data-row-recovery={inline || undefined}>
    {item.status === 'failed' && item.error?.retryable && <button {...buttonProps} disabled={unavailable}
      aria-label={inline ? `Retry save for ${item.companyName}` : undefined}
      onClick={(event) => { event.stopPropagation(); begin(event.currentTarget); if (single) void operations.retry(id); else bulk.retryItem(id) }}>Retry save</button>}
    {item.status === 'unconfirmed' && <>
      <button {...buttonProps} disabled={expired || item.checking || (!single && !online)}
        aria-label={inline ? `Check status for ${item.companyName}` : undefined}
        onClick={(event) => { event.stopPropagation(); begin(event.currentTarget); if (single) void operations.reconcile(id); else void bulk.reconcileItem(id) }}>
        {item.checking ? 'Checking…' : 'Check status'}</button>
      {!inline && item.canResume && <button {...buttonProps} disabled={unavailable}
        onClick={(event) => { begin(event.currentTarget); if (single) void operations.retry(id); else bulk.retryItem(id) }}>Retry original change</button>}
    </>}
    {review && mode !== 'detail' && <button {...buttonProps} disabled={unavailable}
      aria-label={inline ? `Review conflict for ${item.companyName}` : undefined}
      onClick={(event) => { event.stopPropagation(); details(event.currentTarget) }}>Review conflict</button>}
    {undoable && !unavailable && <button {...buttonProps} className={styles.undoButton}
      aria-label={inline ? `Undo move for ${item.companyName}` : undefined}
      title={`Undo this move and restore ${STAGE_LABELS[item.previousStage]}`}
      onClick={(event) => {
        event.stopPropagation(); begin(event.currentTarget)
        if (single) operations.undo(id)
        else if (groupId) { const preview = bulk.previewUndo(groupId, id); if (preview) controller.confirmUndo(preview, event.currentTarget) }
      }}>
      <svg viewBox="0 0 20 20" aria-hidden="true"><path d="m7 4-4 4 4 4M3 8h8a5 5 0 0 1 0 10H9" /></svg>
      <span>{inline ? 'Undo' : 'Undo move'}</span>
    </button>}
    {mode !== 'detail' && !review && <button {...buttonProps} className={styles.detailsButton}
      aria-label={`View change details for ${item.companyName}`} aria-haspopup="dialog" title="View change details and recovery options"
      onClick={(event) => { event.stopPropagation(); details(event.currentTarget) }}>
      <span>Details</span>
      <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8h10m-4-4 4 4-4 4" /></svg>
    </button>}
    {!inline && single && operations.canDismiss(id) && <button {...buttonProps} className={styles.dismiss}
      title="Dismiss this result and its recovery/Undo actions"
      onClick={() => {
        operations.dismiss(id)
        if (mode === 'detail') controller.open({ kind: 'history', filter: 'all' })
        controller.focusPanel()
      }}>Dismiss result</button>}
  </div>
}
