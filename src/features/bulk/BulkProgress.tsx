import { Button } from '../../shared/ui/Button'
import { useStore } from 'zustand'
import { formatCount } from '../../shared/format'
import { useAnnouncement } from '../../shared/use-announcement'
import { useChanges } from '../operations/changes-context'
import styles from './Bulk.module.css'

/** One bounded progress summary, accessible without scrolling to an operation history. */
export function BulkProgress() {
  const { bulk, controller } = useChanges()
  const group = useStore(bulk.store, (state) => state.groups[0])
  const message = group
    ? `${group.kind === 'undo' ? 'Bulk Undo' : 'Bulk move'} · ${formatCount(group.total)} deals · ${formatCount(group.counts.succeeded)} saved · ${formatCount(group.counts.failed)} failed · ${formatCount(group.counts.conflicted)} conflicts · ${formatCount(group.counts.unconfirmed)} unconfirmed · ${formatCount(group.counts.queued + group.counts.saving)} pending · ${formatCount(group.counts.skipped)} skipped${group.paused ? ' · Paused' : ''}`
    : ''
  const announcement = useAnnouncement(message)
  if (!group) return null
  return (
    <div className={styles.progress}>
      <p>{message}</p>
      <Button
        onClick={(event) =>
          controller.open({ kind: 'bulk-group', id: group.id }, event.currentTarget)
        }
      >
        View bulk results
      </Button>
      <span className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">
        {announcement}
      </span>
    </div>
  )
}
