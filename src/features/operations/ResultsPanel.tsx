import { useEffect, useRef, useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { useStore } from 'zustand'
import type { Deal } from '../../domain/deal'
import { STAGE_LABELS } from '../../domain/deal'
import type { ConfirmedReadModel } from '../collaboration/read-model'
import type { Operation, OperationService } from './service'
import { operationLabel, RESULT_LABELS as LABELS } from './presentation'
import styles from './Results.module.css'

function ResultItem({ id, service, onReview, onDismiss }: { id: string; service: OperationService; onReview: (item: Operation, trigger: HTMLElement) => void; onDismiss: () => void }) {
  const item = useStore(service.store, (state) => state.byId[id])
  const expired = useStore(service.store, (state) => state.sessionExpired)
  // Undo eligibility depends on later operations as well as this item.
  const latestId = useStore(service.store, (state) => state.latestByDeal[item?.command.dealId ?? ''])
  const latest = useStore(service.store, (state) => state.byId[latestId])
  const undo = useStore(service.store, (state) => item?.undoId ? state.byId[item.undoId] : undefined)
  useStore(service.store, (state) => state.knownVersions[item?.command.dealId ?? ''])
  const resultRef = useRef<HTMLLIElement>(null)
  const actionRef = useRef<HTMLElement | null>(null)
  useEffect(() => {
    if (actionRef.current && !actionRef.current.isConnected && document.activeElement === document.body) resultRef.current?.focus()
  }, [item?.status, item?.checking, item?.undoId])
  if (!item) return null
  const blocked = latest && ['queued', 'saving', 'unconfirmed'].includes(latest.status)
  const undoable = !expired && !blocked && service.canUndo(id)
  return <li ref={resultRef} tabIndex={-1} className={styles.result} data-testid="operation-result" data-state={item.status}>
    <div className={styles.resultHeading}><strong>{item.companyName}</strong><span className={styles[item.status]}>{operationLabel(item)}</span></div>
    <p>{item.kind === 'undo' ? 'Undo' : 'Move'}: {STAGE_LABELS[item.previousStage]} → {STAGE_LABELS[item.command.stage]} <span>· Attempt {item.attempts}</span></p>
    {(item.message || item.error) && <p className={styles.message}>{item.message ?? item.error?.message}</p>}
    {item.reviewedBy && <p>Reviewed replacement submitted; this original conflict is retained.</p>}
    {undo && <p>Undo result: {LABELS[undo.status]}</p>}
    <div className={styles.actions}>
      {!expired && item.status === 'failed' && item.error?.retryable && <button disabled={Boolean(blocked)} onClick={(event) => { actionRef.current = event.currentTarget; void service.retry(id) }}>Retry save</button>}
      {!expired && item.status === 'unconfirmed' && <>
        <button disabled={item.checking} onClick={(event) => { actionRef.current = event.currentTarget; void service.reconcile(id) }}>{item.checking ? 'Checking status…' : 'Check status'}</button>
        {item.canResume && <button onClick={(event) => { actionRef.current = event.currentTarget; void service.retry(id) }}>Retry original change</button>}
      </>}
      {!expired && item.status === 'conflicted' && !item.reviewedBy && <button disabled={Boolean(blocked)} onClick={(event) => onReview(item, event.currentTarget)}>Review conflict</button>}
      {undoable && <button onClick={(event) => { actionRef.current = event.currentTarget; service.undo(id) }}>Undo move</button>}
      {service.canDismiss(id) && <button className={styles.dismiss} title="Dismiss this result and its recovery/Undo actions" onClick={() => { service.dismiss(id); onDismiss() }}>Dismiss result</button>}
    </div>
  </li>
}

export function ResultsPanel({ service, model }: { service: OperationService; model: ConfirmedReadModel }) {
  const order = useStore(service.store, (state) => state.order)
  const notice = useStore(service.store, (state) => state.notice)
  const expired = useStore(service.store, (state) => state.sessionExpired)
  const summary = useStore(service.store, (state) => {
    const results = Object.values(state.byId)
    return `${results.filter((item) => item.status === 'succeeded').length} saved, ${results.filter((item) => item.status === 'saving' || item.status === 'queued').length} saving, ${results.filter((item) => item.status === 'failed').length} failed, ${results.filter((item) => item.status === 'conflicted').length} conflicts, ${results.filter((item) => item.status === 'unconfirmed').length} unconfirmed, ${results.filter((item) => item.status === 'skipped').length} skipped`
  })
  const [review, setReview] = useState<{ item: Operation; record: Deal } | null>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const fallbackRef = useRef<HTMLHeadingElement>(null)

  return <section className={styles.panel} aria-label="Save results">
    <div className={styles.heading}><h2 ref={fallbackRef} tabIndex={-1}>Recent changes</h2><span>{order.length} / 200 results</span></div>
    <p role="status" aria-live="polite" aria-atomic="true">{summary}</p>
    {notice && <p role="alert">{notice}</p>}
    {expired && <div role="alert"><p>The demo session was reset. Reload to load the current records; old-session receipts cannot be recovered.</p><button onClick={() => window.location.reload()}>Reload workspace</button></div>}
    {!order.length ? <p>Edit a stage with Enter or F2. Save results and recovery actions will stay here.</p> : <>
      <p className={styles.hint}>Dismissing a resolved result removes its Retry and Undo actions. Unconfirmed changes stay until resolved.</p>
      <ul className={styles.results}>{order.map((id) => <ResultItem key={id} id={id} service={service} onDismiss={() => fallbackRef.current?.focus()} onReview={(item, trigger) => {
        triggerRef.current = trigger
        setReview({ item, record: model.get(item.command.dealId) ?? item.conflict! })
      }} />)}</ul>
    </>}
    <Dialog.Root open={Boolean(review)} onOpenChange={(open) => { if (!open) setReview(null) }}>
      <Dialog.Portal><Dialog.Overlay className={styles.overlay} /><Dialog.Content className={styles.dialog}
        onCloseAutoFocus={(event) => { event.preventDefault(); (triggerRef.current?.isConnected ? triggerRef.current : fallbackRef.current)?.focus() }}>
        <Dialog.Title>Review stage conflict</Dialog.Title>
        <Dialog.Description>A newer saved version exists. Compare it with your intended change before submitting a new guarded command.</Dialog.Description>
        {review && <>
          <strong>{review.record.companyName}</strong>
          <dl><dt>Previously reviewed stage</dt><dd>{STAGE_LABELS[review.item.previousStage]} (version {review.item.command.expectedVersion})</dd>
            <dt>Latest confirmed stage</dt><dd>{STAGE_LABELS[review.record.stage]} (version {review.record.version})</dd>
            <dt>Your intended stage</dt><dd>{STAGE_LABELS[review.item.command.stage]}</dd></dl>
          <p>This submits the version shown here. Another intervening change will produce another conflict.</p>
          <div className={styles.actions}><Dialog.Close asChild><button>Keep latest stage</button></Dialog.Close>
            <button onClick={() => { if (service.review(review.item.id, review.record)) setReview(null) }}>Apply reviewed change</button></div>
        </>}
      </Dialog.Content></Dialog.Portal>
    </Dialog.Root>
  </section>
}
