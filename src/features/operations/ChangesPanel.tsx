import { Button } from '../../shared/ui/Button'
import { useStore } from 'zustand'
import { useEffect, useRef } from 'react'
import { SidePanel } from '../../shared/ui/SidePanel'
import type { SidePanelHandle } from '../../shared/ui/SidePanel'
import { BulkResults } from '../bulk/BulkResults'
import { BulkReview } from '../bulk/BulkReview'
import { useChanges } from './changes-context'
import { CommandDetails } from './CommandDetails'
import { ResultsPanel } from './ResultsPanel'
import { needsAction } from './outcomes'
import styles from './Changes.module.css'

export function ChangesPanel() {
  const { controller, operations, bulk, model } = useChanges()
  const panel = useRef<SidePanelHandle>(null)
  const undoSubmitted = useRef(false)
  useEffect(() => controller.registerFocus(() => panel.current?.focusHeading()), [controller])
  const { open, target, undo } = useStore(controller.store)
  useEffect(() => {
    if (undo) undoSubmitted.current = false
  }, [undo])
  const singleCount = useStore(operations.store, (state) =>
    !open || target.kind !== 'history'
      ? 0
      : target.filter === 'all'
        ? state.order.length
        : Object.values(state.byId).filter(needsAction).length,
  )
  const bulkCount = useStore(bulk.store, (state) =>
    !open || target.kind !== 'history'
      ? 0
      : state.groups.filter((group) => target.filter === 'all' || group.needsAction > 0).length,
  )
  const notice = useStore(operations.store, (state) => state.notice)
  const expired = useStore(operations.store, (state) => state.sessionExpired)
  const title =
    target.kind === 'history'
      ? 'Recent changes'
      : target.kind === 'bulk-group'
        ? 'Bulk operation'
        : 'Change details'
  return (
    <>
      <SidePanel
        ref={panel}
        open={open}
        onOpenChange={(value) => {
          if (!value) controller.close()
        }}
        title={title}
        closeLabel="Close changes panel"
        description="Save results, recovery, and reviewed changes for this session."
        returnFocus={controller.returnFocus}
      >
        {notice && (
          <p className={styles.warning} role="alert">
            {notice}
          </p>
        )}
        {expired && (
          <div role="alert">
            <p>This demo session expired. Reload before starting more changes.</p>
            <Button onClick={() => location.reload()}>Reload workspace</Button>
          </div>
        )}
        {target.kind === 'history' ? (
          <>
            <div className={styles.filters} role="group" aria-label="Filter changes">
              <Button
                aria-pressed={target.filter === 'needs-action'}
                onClick={() => controller.open({ kind: 'history', filter: 'needs-action' })}
              >
                Needs action
              </Button>
              <Button
                aria-pressed={target.filter === 'all'}
                onClick={() => controller.open({ kind: 'history', filter: 'all' })}
              >
                All changes
              </Button>
            </div>
            {singleCount + bulkCount === 0 && (
              <p className={styles.hint}>
                {target.filter === 'all'
                  ? 'No changes yet. Stage changes and their recovery actions will appear here.'
                  : 'No changes need action. Saved results remain available under All changes.'}
              </p>
            )}
            {singleCount > 0 && <ResultsPanel filter={target.filter} />}
            {bulkCount > 0 && (
              <BulkResults
                service={bulk}
                model={model}
                embedded
                needsActionOnly={target.filter === 'needs-action'}
              />
            )}
          </>
        ) : (
          <>
            <Button
              className={styles.back}
              onClick={() => controller.open({ kind: 'history', filter: 'all' })}
            >
              ← All changes
            </Button>
            {target.kind === 'bulk-group' ? (
              <BulkResults service={bulk} model={model} embedded groupId={target.id} />
            ) : (
              <CommandDetails target={target} />
            )}
          </>
        )}
      </SidePanel>
      <BulkReview
        preview={undo}
        service={bulk}
        onClose={controller.closeUndo}
        restoreFocus={() => {
          const invoker = controller.returnFocus()
          return undoSubmitted.current || invoker?.id === 'changes-trigger'
            ? (panel.current?.getFocusTarget() ?? invoker)
            : invoker
        }}
        onSubmitted={(id) => {
          undoSubmitted.current = true
          controller.open({ kind: 'bulk-group', id })
        }}
      />
    </>
  )
}
