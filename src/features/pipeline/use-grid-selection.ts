import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { GridApi, IRowNode, RowSelectedEvent } from 'ag-grid-community'
import { cooperate } from '../../shared/cooperative'
import type { PipelineFilters } from '../../domain/filters'
import type { SelectionChange, SelectionService } from '../bulk/selection'
import type { PipelineRow } from './projection'

/** Mirror only selection deltas, in bounded native-grid batches; desired membership stays authoritative. */
export function useGridSelection(
  apiRef: RefObject<GridApi<PipelineRow> | null>,
  selection: SelectionService,
  filters: PipelineFilters,
) {
  const synchronizing = useRef(false)
  const queue = useRef<(readonly string[])[]>([])
  const flight = useRef<AbortController | null>(null)
  const apply = useCallback(
    ({ added, removed }: SelectionChange) => {
      queue.current = [...queue.current, removed, added]
      if (flight.current) return
      const controller = new AbortController()
      flight.current = controller
      function* mirror() {
        while (queue.current.length) {
          const [ids, ...rest] = queue.current
          queue.current = rest
          for (let offset = 0; offset < ids.length; offset += 64) {
            const api = apiRef.current
            if (!api) return
            const selected: IRowNode<PipelineRow>[] = []
            const deselected: IRowNode<PipelineRow>[] = []
            for (let index = offset; index < Math.min(offset + 64, ids.length); index++) {
              const node = api.getRowNode(ids[index])
              const desired = selection.has(ids[index])
              if (node && node.isSelected() !== desired)
                (desired ? selected : deselected).push(node)
            }
            synchronizing.current = true
            try {
              if (selected.length) api.setNodesSelected({ nodes: selected, newValue: true })
              if (deselected.length) api.setNodesSelected({ nodes: deselected, newValue: false })
            } finally {
              synchronizing.current = false
            }
            yield
          }
        }
        if (flight.current === controller) flight.current = null
      }
      void cooperate(mirror(), controller.signal)
        .catch((error: unknown) => {
          if (!controller.signal.aborted) throw error
        })
        .finally(() => {
          if (flight.current === controller) flight.current = null
        })
    },
    [apiRef, selection],
  )
  useEffect(() => {
    const stop = selection.subscribe(apply)
    return () => {
      stop()
      flight.current?.abort()
      flight.current = null
      queue.current = []
    }
  }, [selection, apply])
  const syncSelection = useCallback(
    () => apply({ added: selection.records().map((record) => record.id), removed: [] }),
    [selection, apply],
  )
  const rowSelected = useCallback(
    ({ node, data, source }: RowSelectedEvent<PipelineRow>) => {
      if (
        data &&
        !synchronizing.current &&
        (source === 'checkboxSelected' || source === 'spaceKey' || source === 'rowClicked')
      )
        selection.setSelected(data.deal, node.isSelected() === true, filters)
    },
    [selection, filters],
  )
  return { syncSelection, rowSelected }
}
