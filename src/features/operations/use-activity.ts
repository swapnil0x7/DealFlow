import { useCallback, useSyncExternalStore } from 'react'
import type { ActivityRegistry } from './activity'

export function useActivity(activity: ActivityRegistry, dealId: string) {
  return useSyncExternalStore(
    useCallback((listener) => activity.subscribe(dealId, listener), [activity, dealId]),
    useCallback(() => activity.get(dealId), [activity, dealId]),
  )
}
