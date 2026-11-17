import { useStore } from 'zustand'
import { useChanges } from './changes-context'
import { needsAction } from './outcomes'
import { useAnnouncement } from '../../shared/use-announcement'
import styles from './Changes.module.css'

export function ChangesButton() {
  const { operations, bulk, controller } = useChanges()
  const singles = useStore(operations.store, (state) => Object.values(state.byId).filter(needsAction).length)
  const bulks = useStore(bulk.store, (state) => state.groups.reduce((count, group) => count + group.needsAction, 0))
  const saving = useStore(operations.store, (state) => Object.values(state.byId).some((item) => item.status === 'saving' || item.status === 'queued'))
  const bulkSaving = useStore(bulk.store, (state) => state.groups.some((group) => group.counts.queued + group.counts.saving > 0))
  const count = singles + bulks
  const announcement = useAnnouncement(count ? `${count} changes need action. Open Changes to review them.` : '')
  return <><button type="button" id="changes-trigger" className={styles.trigger} aria-haspopup="dialog"
    onClick={(event) => controller.open({ kind: 'history', filter: count ? 'needs-action' : 'all' }, event.currentTarget)}>
    <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 3h8M4 8h8M4 13h8M1 3h.01M1 8h.01M1 13h.01" /></svg>
    Changes {count > 0 ? <span className={styles.badge}>{count.toLocaleString('en-IN')} need action</span> : (saving || bulkSaving) && <span className={styles.hint}>Saving…</span>}
  </button><span className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">{announcement}</span></>
}
