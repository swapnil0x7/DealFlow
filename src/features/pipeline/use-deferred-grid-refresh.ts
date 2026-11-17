import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { GridApi, IRowNode } from 'ag-grid-community'
import { compareAttention } from '../../domain/attention'
import { matchesFilters } from '../../domain/filters'
import type { PipelineFilters } from '../../domain/filters'
import type { SelectionService } from '../bulk/selection'
import type { PipelineRow } from './projection'

const QUIET_PERIOD_MS = 5_000
interface Options {
  apiRef: RefObject<GridApi<PipelineRow> | null>
  deferredRows: RefObject<Map<string, PipelineRow>>
  editingId: RefObject<string | null>
  selection: SelectionService
  filters: PipelineFilters
  listRefreshReason: 'records' | 'time' | null
  onStaleChange: (reason: 'records' | 'time' | null) => void
}

/** Owns the policy for deferring reordered lists while a user is working. */
export function useDeferredGridRefresh({
  apiRef,
  deferredRows,
  editingId,
  selection,
  filters,
  listRefreshReason,
  onStaleChange,
}: Options) {
  const recordRefreshPending = useRef(false)
  const priorityPending = useRef(false)
  const lastInteractionAt = useRef(Number.NEGATIVE_INFINITY)
  const updatePriorityNotice = useCallback(
    (pending: boolean) => {
      priorityPending.current = pending
      onStaleChange(recordRefreshPending.current ? 'records' : pending ? 'time' : null)
    },
    [onStaleChange],
  )
  const timeAffectsList = useCallback(() => {
    const api = apiRef.current
    if (!api) return false
    const currentRow = (node: IRowNode<PipelineRow>) =>
      deferredRows.current.get(node.id ?? '') ?? node.data
    let affected = false
    api.forEachNode((node) => {
      const row = currentRow(node)
      if (row && matchesFilters(row, filters) !== (node.rowIndex !== null)) affected = true
    })
    const direction = api.getColumnState().find((column) => column.colId === 'attention')?.sort
    if (direction && !affected) {
      let previous: PipelineRow | undefined
      api.forEachNodeAfterFilterAndSort((node) => {
        const row = currentRow(node)
        if (row && previous && compareAttention(previous, row) * (direction === 'asc' ? 1 : -1) > 0)
          affected = true
        if (row) previous = row
      })
    }
    return affected
  }, [apiRef, deferredRows, filters])
  const canRefreshQuietly = useCallback(
    () =>
      !document.hidden &&
      !editingId.current &&
      performance.now() - lastInteractionAt.current >= QUIET_PERIOD_MS &&
      selection.store.getState().count === 0 &&
      !document.activeElement?.closest('[data-pipeline-workspace]') &&
      !document.querySelector('[role="dialog"], [role="listbox"]'),
    [selection, editingId],
  )
  const reconcileTime = useCallback(() => {
    if (recordRefreshPending.current) {
      // One existing list-refresh action reconciles both data and clock changes.
      updatePriorityNotice(false)
      return
    }
    const affected = timeAffectsList()
    if (affected && canRefreshQuietly()) {
      apiRef.current?.refreshClientSideRowModel('filter')
      updatePriorityNotice(false)
    } else updatePriorityNotice(affected)
  }, [apiRef, timeAffectsList, canRefreshQuietly, updatePriorityNotice])
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const reconsider = () => {
      clearTimeout(timer)
      // Wait for focus to reach its destination, including portaled menus/dialogs.
      timer = setTimeout(() => {
        if (!priorityPending.current) return
        const remaining = QUIET_PERIOD_MS - (performance.now() - lastInteractionAt.current)
        if (remaining > 0) timer = setTimeout(reconsider, remaining)
        else if (canRefreshQuietly()) reconcileTime()
      }, 0)
    }
    const interacted = () => {
      lastInteractionAt.current = performance.now()
      reconsider()
    }
    // Scrolling with a wheel or touch need not focus a control, but still counts as active work.
    for (const event of ['pointerdown', 'keydown', 'wheel', 'touchmove'])
      document.addEventListener(event, interacted, { capture: true, passive: true })
    document.addEventListener('focusin', reconsider)
    document.addEventListener('focusout', reconsider)
    document.addEventListener('visibilitychange', reconsider)
    window.addEventListener('focus', reconsider)
    const unsubscribe = selection.subscribe(reconsider)
    reconsider()
    return () => {
      clearTimeout(timer)
      unsubscribe()
      for (const event of ['pointerdown', 'keydown', 'wheel', 'touchmove'])
        document.removeEventListener(event, interacted, true)
      document.removeEventListener('focusin', reconsider)
      document.removeEventListener('focusout', reconsider)
      document.removeEventListener('visibilitychange', reconsider)
      window.removeEventListener('focus', reconsider)
    }
  }, [reconcileTime, canRefreshQuietly, selection, listRefreshReason])
  const recordChanges = useCallback(() => {
    recordRefreshPending.current = true
    updatePriorityNotice(false)
  }, [updatePriorityNotice])
  const resetRefresh = useCallback(() => {
    recordRefreshPending.current = false
    updatePriorityNotice(false)
  }, [updatePriorityNotice])
  const hasPendingPriority = useCallback(() => priorityPending.current, [])
  return { recordChanges, resetRefresh, hasPendingPriority, reconcileTime }
}
