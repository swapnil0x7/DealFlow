import { useStore } from 'zustand'
import { STAGE_LABELS } from '../../domain/deal'
import { formatTime } from '../../shared/format'
import { useAnnouncement } from '../../shared/use-announcement'
import { useChanges } from './changes-context'
import { CommandActions } from './CommandActions'
import { operationLabel, RESULT_LABELS } from './presentation'
import { needsAction, resolution } from './outcomes'
import styles from './Changes.module.css'

function ResultItem({ id }: { id: string }) {
  const { operations } = useChanges()
  const item = useStore(operations.store, (state) => state.byId[id])
  const undo = useStore(operations.store, (state) => item?.undoId ? state.byId[item.undoId] : undefined)
  if (!item) return null
  const handled = resolution(item)
  return <li className={styles.card} tabIndex={-1} data-focus-fallback data-testid="operation-result" data-state={item.status} data-resolved={Boolean(handled)}>
    <h3>{item.companyName}</h3>
    <time className={styles.hint} dateTime={new Date(item.createdAt).toISOString()}>{formatTime(item.createdAt)}</time>
    <span className={styles.status}>{operationLabel(item)}{handled === 'kept' ? ' · latest stage kept' : handled ? ' · reviewed replacement submitted' : ''}</span>
    <p>{item.kind === 'undo' ? 'Undo' : 'Move'}: {STAGE_LABELS[item.previousStage]} → {STAGE_LABELS[item.command.stage]} · Attempt {item.attempts}</p>
    {(item.message || item.error) && <p className={styles.hint}>{item.message ?? item.error?.message}</p>}
    {undo && <p className={styles.hint}>Undo result: {RESULT_LABELS[undo.status]}</p>}
    <CommandActions id={id} dealId={item.command.dealId} mode="history" />
  </li>
}

/** The same saved operations are rendered in the shared panel, independent of grid membership. */
export function ResultsPanel({ filter }: { filter: 'all' | 'needs-action' }) {
  const { operations } = useChanges()
  const order = useStore(operations.store, (state) => state.order)
  const items = useStore(operations.store, (state) => state.byId)
  const shown = filter === 'all' ? order : order.filter((id) => needsAction(items[id]))
  const summary = useAnnouncement(`${order.filter((id) => items[id].status === 'succeeded').length} saved, ${order.filter((id) => ['queued', 'saving'].includes(items[id].status)).length} saving, ${order.filter((id) => items[id].status === 'failed').length} failed, ${order.filter((id) => items[id].status === 'conflicted').length} conflicts, ${order.filter((id) => items[id].status === 'unconfirmed').length} unconfirmed, ${order.filter((id) => items[id].status === 'skipped').length} skipped`)
  return <section aria-label="Save results">
    <h3 className={styles.sectionTitle}>Individual changes <span className={styles.hint}>({shown.length})</span></h3>
    <p className={styles.hint} role="status" aria-live="polite" aria-atomic="true">{summary}</p>
    {!shown.length ? <p className={styles.hint}>{filter === 'all' ? 'Individual stage changes and their recovery actions will appear here.' : 'No individual changes need action.'}</p> :
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{shown.map((id) => <ResultItem key={id} id={id} />)}</ul>}
    <p className={styles.hint}>{order.length} / 200 results. Dismissing a result removes its recovery and Undo actions.</p>
  </section>
}
