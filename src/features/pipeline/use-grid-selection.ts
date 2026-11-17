import { useCallback, useEffect, useRef } from 'react'
import type { RefObject } from 'react'
import type { GridApi, RowSelectedEvent } from 'ag-grid-community'
import type { PipelineFilters } from '../../domain/filters'
import type { SelectionChange, SelectionService } from '../bulk/selection'
import type { PipelineRow } from './projection'

/** Grid selection mirrors reviewed membership through deltas, without resetting unaffected nodes. */
export function useGridSelection(
  apiRef: RefObject<GridApi<PipelineRow> | null>,
  selection: SelectionService,
  filters: PipelineFilters,
) {
  const synchronizing = useRef(false)
  const apply = useCallback(
    ({ added, removed }: SelectionChange) => {
      const api = apiRef.current
      if (!api) return
      synchronizing.current = true
      try {
        for (const [ids, selected] of [
          [removed, false],
          [added, true],
        ] as const) {
          const nodes = ids.flatMap((id) => {
            const node = api.getRowNode(id)
            return node && node.isSelected() !== selected ? [node] : []
          })
          if (nodes.length) api.setNodesSelected({ nodes, newValue: selected })
        }
      } finally {
        synchronizing.current = false
      }
    },
    [apiRef],
  )
  useEffect(() => selection.subscribe(apply), [selection, apply])
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
