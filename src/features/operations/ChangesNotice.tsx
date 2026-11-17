import { useStore } from 'zustand'
import { useChanges } from './changes-context'
import styles from './Changes.module.css'

/** Control-plane errors remain discoverable even while the Changes panel is closed. */
export function ChangesNotice() {
  const { operations, bulk, controller } = useChanges()
  const notice = useStore(operations.store, (state) => state.notice)
  const bulkNotice = useStore(bulk.store, (state) => state.notice)
  const expired = useStore(operations.store, (state) => state.sessionExpired)
  if (!notice && !bulkNotice && !expired) return null
  return (
    <div className={styles.workspaceNotice} role="alert">
      <span>
        {expired ? 'The demo session expired. Reload to continue.' : (notice ?? bulkNotice)}
      </span>
      <button
        onClick={(event) =>
          controller.open({ kind: 'history', filter: 'all' }, event.currentTarget)
        }
      >
        View changes
      </button>
      {expired && <button onClick={() => location.reload()}>Reload workspace</button>}
    </div>
  )
}
