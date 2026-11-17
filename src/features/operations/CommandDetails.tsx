import { useStore } from 'zustand'
import { STAGE_LABELS } from '../../domain/deal'
import type { ChangesTarget } from './changes-controller'
import { useChanges } from './changes-context'
import { useCommand } from './use-command'
import { ConflictReview } from './ConflictReview'
import { CommandActions } from './CommandActions'
import { RESULT_LABELS } from './presentation'
import { resolution } from './outcomes'
import styles from './Changes.module.css'

export function CommandDetails({ target }: { target: Extract<ChangesTarget, { kind: 'single' | 'bulk-item' }> }) {
  const { operations, bulk } = useChanges()
  const single = useStore(operations.store, (state) => state.byId[target.id])
  const bulkItem = bulk.getItemById(target.id)
  const dealId = single?.command.dealId ?? bulkItem?.command.dealId ?? ''
  return <Details target={target} dealId={dealId} />
}

function Details({ target, dealId }: { target: Extract<ChangesTarget, { kind: 'single' | 'bulk-item' }>; dealId: string }) {
  const { operations, bulk, controller } = useChanges()
  const { item, latest, single, blocked, expired, online, groupId } = useCommand(target.id, dealId)
  if (!item) return <p>This result has been dismissed. Your other changes are still available.</p>
  const handled = resolution(item)
  const reviewing = item.status === 'conflicted' && !handled
  const reviewed = target.reviewed ?? item.conflict ?? latest
  const unavailable = expired || blocked || (!single && !online)
  const apply = () => {
    if (!reviewed) return
    if (single) {
      const id = operations.review(target.id, reviewed)
      if (id) controller.open({ kind: 'single', id })
    } else if (groupId) {
      const preview = bulk.previewConflict(groupId, target.id, reviewed)
      const group = preview && bulk.submit(preview)
      const next = group && bulk.page(group, 'all', 0, 1)[0]
      if (next) controller.open({ kind: 'bulk-item', id: next.command.mutationId })
    }
  }
  return <article className={styles.detail} tabIndex={-1} data-focus-fallback data-command-detail data-testid="command-detail" data-state={item.status} data-resolved={Boolean(handled)}>
    <h3>{item.companyName}</h3>
    <p className={styles.status}>{RESULT_LABELS[item.status]}{handled === 'kept' ? ' · latest stage kept' : handled ? ' · reviewed replacement submitted' : ''}</p>
    <p>{STAGE_LABELS[item.previousStage]} → {STAGE_LABELS[item.command.stage]} · Attempt {item.attempts}</p>
    {reviewing && reviewed && latest ? <ConflictReview previousStage={item.previousStage} expectedVersion={item.command.expectedVersion}
      intendedStage={item.command.stage} reviewed={reviewed} latest={latest} disabled={unavailable}
      onReviewLatest={() => controller.open({ ...target, reviewed: latest })}
      onKeep={() => {
        const kept = single ? operations.keepLatest(target.id, reviewed) : bulk.keepLatest(target.id, reviewed)
        if (kept) controller.focusPanel()
      }} onApply={apply} /> :
      <>{(item.message || item.error) && <p className={styles.hint}>{item.message ?? item.error?.message}</p>}
        <CommandActions id={target.id} dealId={dealId} mode="detail" /></>}
    {groupId && <button className={styles.back} onClick={() => controller.open({ kind: 'bulk-group', id: groupId })}>View bulk operation</button>}
  </article>
}
