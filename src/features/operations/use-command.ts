import { useCallback, useSyncExternalStore } from 'react'
import { useStore } from 'zustand'
import { useChanges } from './changes-context'

/** Subscribe only to this command/deal, including bulk items which are indexed outside React. */
export function useCommand(id: string, dealId: string) {
  const { operations, bulk, model } = useChanges()
  const single = useStore(operations.store, (state) => state.byId[id])
  const bulkItem = useSyncExternalStore(
    useCallback((listener) => operations.activity.subscribe(dealId, listener), [operations, dealId]),
    useCallback(() => bulk.getItemById(id), [bulk, id]),
  )
  const latest = useSyncExternalStore(
    useCallback((listener) => model.subscribe(listener), [model]),
    useCallback(() => model.get(dealId), [model, dealId]),
  )
  const singleExpired = useStore(operations.store, (state) => state.sessionExpired)
  const bulkExpired = useStore(bulk.store, (state) => state.expired)
  const online = useStore(bulk.store, (state) => state.online)
  // Claims on a different command for this deal can change action eligibility.
  useSyncExternalStore(
    useCallback((listener) => operations.activity.subscribe(dealId, listener), [operations, dealId]),
    useCallback(() => operations.activity.isBlocked(dealId, id), [operations, dealId, id]),
  )
  return { item: single ?? bulkItem, single: Boolean(single), latest,
    blocked: operations.activity.isBlocked(dealId, id), expired: single ? singleExpired : bulkExpired,
    online, groupId: bulk.groupForItem(id) }
}
