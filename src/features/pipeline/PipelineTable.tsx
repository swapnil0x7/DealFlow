import { useCallback, useEffect, useMemo, useRef } from 'react'
import { useStore } from 'zustand'
import { AgGridReact } from 'ag-grid-react'
import {
  CellStyleModule,
  ClientSideRowModelModule,
  ClientSideRowModelApiModule,
  ColumnApiModule,
  ExternalFilterModule,
  CustomEditorModule,
  ModuleRegistry,
  RenderApiModule,
  RowApiModule,
  RowSelectionModule,
  ScrollApiModule,
  TooltipModule,
  ValidationModule,
  themeQuartz,
} from 'ag-grid-community'
import type {
  CellEditRequestEvent,
  CellFocusedEvent,
  ColDef,
  GridApi,
  GridReadyEvent,
  ICellEditorParams,
  ICellRendererParams,
  IRowNode,
  ModelUpdatedEvent,
  MultiRowSelectionOptions,
  SortChangedEvent,
} from 'ag-grid-community'
import { compareAttention } from '../../domain/attention'
import { useDeferredGridRefresh } from './use-deferred-grid-refresh'
import { STAGE_LABELS, isStage } from '../../domain/deal'
import type { Deal, Owner } from '../../domain/deal'
import { matchesFilters } from '../../domain/filters'
import type { PipelineFilters, WorkView } from '../../domain/filters'
import { formatDate, formatMoney } from '../../shared/format'
import type { PipelineProjection, PipelineRow } from './projection'
import type { OperationService } from '../operations/service'
import { activityLabel } from '../operations/presentation'
import { useActivity } from '../operations/use-activity'
import { StageCell, StageEditor } from './StageCell'
import type { TableContext } from './table-context'
import { SelectionBar } from '../bulk/SelectionBar'
import { useGridSelection } from './use-grid-selection'
import type { SelectionService } from '../bulk/selection'
import type { BulkService } from '../bulk/service'
import styles from './Pipeline.module.css'

ModuleRegistry.registerModules([
  ClientSideRowModelModule,
  ClientSideRowModelApiModule,
  CustomEditorModule,
  ExternalFilterModule,
  ColumnApiModule,
  RowApiModule,
  ScrollApiModule,
  RenderApiModule,
  CellStyleModule,
  TooltipModule,
  RowSelectionModule,
  ...(import.meta.env.DEV ? [ValidationModule] : []),
])

const ROW_HEIGHT = 84
const theme = themeQuartz.withParams({
  rowHeight: ROW_HEIGHT,
  accentColor: '#11665c',
  backgroundColor: '#ffffff',
  foregroundColor: '#243d37',
  headerBackgroundColor: '#f7f9f8',
  headerTextColor: '#52665f',
  borderColor: '#e2e8e4',
  fontFamily: 'inherit',
  fontSize: 13,
  headerFontSize: 12,
  headerFontWeight: 600,
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  rowHoverColor: '#f3f8f5',
  cellHorizontalPadding: 20,
  rowBorder: { color: '#edf0ed' },
  focusShadow: 'none',
  inputFocusShadow: 'none',
  inputFocusBorder: { color: '#e2e8e4' },
  pickerButtonFocusBorder: { color: '#e2e8e4' },
  rangeSelectionBorderColor: 'transparent',
  cellEditingBorder: { color: 'transparent' },
})

function CompanyCell({ data, context }: ICellRendererParams<PipelineRow, unknown, TableContext>) {
  const changed = useStore(context.selection.store, () =>
    context.selection.isChanged(data?.deal.id ?? ''),
  )
  return (
    data && (
      <div className={styles.company}>
        <strong>{data.deal.companyName}</strong>
        <span>{data.deal.id.toUpperCase()}</span>
        {!matchesFilters(data, context.filters) && (
          <small className={styles.staleRow}>No longer matches filters</small>
        )}
        {changed && <small className={styles.staleRow}>Selection uses an earlier version</small>}
      </div>
    )
  )
}

function StatusCell({ data, context }: ICellRendererParams<PipelineRow, unknown, TableContext>) {
  const item = useActivity(context.operations.activity, data?.deal.id ?? '')
  return <span>{item ? activityLabel(item) : 'Confirmed'}</span>
}

const columns: ColDef<PipelineRow>[] = [
  {
    colId: 'company',
    headerName: 'Company',
    valueGetter: ({ data }) => data?.deal.companyName,
    cellRenderer: CompanyCell,
    minWidth: 240,
    flex: 1.3,
    sort: 'asc',
  },
  {
    colId: 'value',
    headerName: 'Value',
    valueGetter: ({ data }) => data?.deal.valuePaise,
    valueFormatter: ({ value }) => formatMoney(value as number),
    width: 155,
    cellClass: styles.money,
  },
  { colId: 'owner', headerName: 'Owner', field: 'ownerName', width: 170 },
  {
    colId: 'stage',
    headerName: 'Stage',
    field: 'deal.stage',
    cellDataType: false,
    valueFormatter: ({ value }) => (isStage(value) ? STAGE_LABELS[value] : ''),
    editable: ({ data, context }) =>
      Boolean(data && !(context as TableContext).operations.isBlocked(data.deal.id)),
    cellEditor: StageEditor,
    cellClass: styles.stageColumn,
    cellEditorParams: ({ data, context }: ICellEditorParams<PipelineRow>) => {
      if (data) (context as TableContext).captureEdit(data.deal)
      return {}
    },
    headerTooltip:
      'Click a stage dropdown or press Enter or F2 on its cell to edit. Escape cancels.',
    cellRenderer: StageCell,
    width: 200,
    minWidth: 200,
  },
  {
    colId: 'activity',
    headerName: 'Last customer activity',
    minWidth: 180,
    width: 180,
    valueGetter: ({ data }) => data?.deal.lastActivityAt ?? null,
    valueFormatter: ({ value }) => (value ? formatDate(value as string) : 'No activity yet'),
    tooltip: ({ data }) =>
      data?.deal.lastActivityAt
        ? `Last customer activity: ${formatDate(data.deal.lastActivityAt)}`
        : `No recorded customer activity. Attention uses creation date: ${data ? formatDate(data.deal.createdAt) : ''}`,
  },
  {
    colId: 'attention',
    headerName: 'Attention reason',
    minWidth: 255,
    flex: 1.2,
    valueGetter: ({ data }) => data?.attention?.reason ?? 'No attention flag',
    cellClass: ({ data }) => (data?.attention ? styles.attention : styles.muted),
    tooltip: true,
    comparator: (_a, _b, a, b) => (a.data && b.data ? compareAttention(a.data, b.data) : 0),
  },
  {
    colId: 'status',
    headerName: 'Save status',
    valueGetter: () => 'Confirmed',
    cellRenderer: StatusCell,
    width: 190,
    sortable: false,
    cellClass: styles.muted,
  },
]

// All-matching selection must reconcile stale membership through the explicit toolbar action.
const suppressGridSelectAll: ColDef<PipelineRow>['suppressKeyboardEvent'] = ({ event }) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') return true
  const target = event.target as HTMLElement
  const cell = target.closest<HTMLElement>('[role="gridcell"]')
  if (!cell) return false
  const controls = Array.from(
    cell.querySelectorAll<HTMLButtonElement>('[data-row-recovery] button:not(:disabled)'),
  )
  if (event.key === 'Tab' && controls.length) {
    const index = controls.indexOf(target as HTMLButtonElement)
    const next = event.shiftKey
      ? index > 0
        ? controls[index - 1]
        : index === 0
          ? cell
          : null
      : index < controls.length - 1
        ? controls[index + 1]
        : null
    if (next) {
      event.preventDefault()
      next.focus()
      return true
    }
  }
  return target.tagName === 'BUTTON' && ['Enter', ' '].includes(event.key)
}
const defaultColumn: ColDef<PipelineRow> = {
  sortable: true,
  resizable: true,
  filter: false,
  suppressKeyboardEvent: suppressGridSelectAll,
}
const rowSelection: MultiRowSelectionOptions<PipelineRow> = {
  mode: 'multiRow',
  headerCheckbox: false,
  enableClickSelection: false,
}
const selectionColumn: ColDef<PipelineRow> = {
  headerName: 'Select',
  width: 100,
  pinned: 'left',
  resizable: false,
  sortable: false,
  suppressKeyboardEvent: suppressGridSelectAll,
}
const getRowId = ({ data }: { data: PipelineRow }) => data.deal.id
const isExternalFilterPresent = () => true
const overlayParams = {
  noRows: { overlayText: 'No deals are available yet.' },
  noMatchingRows: { overlayText: 'No deals match this view. Adjust or clear your filters.' },
}

function applyViewSort(api: GridApi<PipelineRow>, view: WorkView) {
  api.applyColumnState({
    state: [{ colId: view === 'attention' ? 'attention' : 'company', sort: 'asc' }],
    defaultState: { sort: null },
  })
}

interface Props {
  projection: PipelineProjection
  operations: OperationService
  selection: SelectionService
  bulk: BulkService
  owners: readonly Owner[]
  searching: boolean
  filters: PipelineFilters
  onCountChange: (count: number) => void
  onSortChange: (description: string) => void
  onStaleChange: (reason: 'records' | 'time' | null) => void
  listRefreshReason: 'records' | 'time' | null
  onActiveDealChange: (id: string) => void
}

export function PipelineTable({
  projection,
  operations,
  selection,
  bulk,
  owners,
  searching,
  filters,
  onCountChange,
  onSortChange,
  onStaleChange,
  listRefreshReason,
  onActiveDealChange,
}: Props) {
  const apiRef = useRef<GridApi<PipelineRow> | null>(null)
  const reviewedEdit = useRef<Deal | null>(null)
  const editingId = useRef<string | null>(null)
  const deferredRows = useRef(new Map<string, PipelineRow>())
  const listStale = listRefreshReason !== null
  const priorityRefreshPending = listRefreshReason === 'time'
  const { recordChanges, resetRefresh, hasPendingPriority, reconcileTime } = useDeferredGridRefresh(
    {
      apiRef,
      deferredRows,
      editingId,
      selection,
      filters,
      listRefreshReason,
      onStaleChange,
    },
  )
  const context = useMemo<TableContext>(
    () => ({
      operations,
      selection,
      filters,
      captureEdit: (record) => {
        reviewedEdit.current = record
        editingId.current = record.id
      },
    }),
    [operations, selection, filters],
  )
  const passesFilter = useCallback(
    (node: IRowNode<PipelineRow>) => Boolean(node.data && matchesFilters(node.data, filters)),
    [filters],
  )
  const { syncSelection, rowSelected } = useGridSelection(apiRef, selection, filters)

  useEffect(() => {
    // Deliberately changing criteria accepts the latest list, without recapturing selection versions.
    apiRef.current?.onFilterChanged()
    apiRef.current?.refreshCells({ columns: ['company'], force: true })
    resetRefresh()
  }, [filters, projection, resetRefresh])
  useEffect(
    () =>
      projection.subscribeRows((rows, source) => {
        const immediate = rows.filter((row) => {
          if (row.deal.id !== editingId.current) return true
          deferredRows.current.set(row.deal.id, row)
          return false
        })
        if (immediate.length && apiRef.current) {
          const transaction = apiRef.current.applyTransaction({ update: immediate })
          apiRef.current.refreshCells({
            rowNodes: transaction?.update,
            columns: ['company'],
            force: true,
          })
        }
        if (source === 'time') reconcileTime()
        else recordChanges()
      }),
    [projection, reconcileTime, recordChanges],
  )
  useEffect(() => {
    if (apiRef.current) applyViewSort(apiRef.current, filters.view)
  }, [filters.view])

  const ready = useCallback(
    ({ api }: GridReadyEvent<PipelineRow>) => {
      apiRef.current = api
      api.setGridAriaProperty('label', 'Sales pipeline deals')
      api.setGridAriaProperty('describedby', 'pipeline-keyboard-help')
      applyViewSort(api, filters.view)
      syncSelection()
    },
    [filters.view, syncSelection],
  )
  const modelUpdated = useCallback(
    ({ api }: ModelUpdatedEvent<PipelineRow>) => onCountChange(api.getDisplayedRowCount()),
    [onCountChange],
  )
  const sortChanged = useCallback(
    ({ api }: SortChangedEvent<PipelineRow>) => {
      const sorted = api.getColumnState().filter((column) => column.sort)
      onSortChange(
        sorted.length
          ? sorted
              .map((column) =>
                column.colId === 'attention'
                  ? column.sort === 'asc'
                    ? 'Attention priority'
                    : 'Attention priority (lowest first)'
                  : `${columns.find((definition) => definition.colId === column.colId)?.headerName ?? column.colId} ${column.sort === 'asc' ? 'ascending' : 'descending'}`,
              )
              .join(', ')
          : 'Original order',
      )
      if (hasPendingPriority()) reconcileTime()
    },
    [onSortChange, reconcileTime, hasPendingPriority],
  )

  const requestEdit = useCallback(
    ({ data, newValue }: CellEditRequestEvent<PipelineRow>) => {
      if (data && isStage(newValue)) {
        const record = reviewedEdit.current?.id === data.deal.id ? reviewedEdit.current : data.deal
        operations.move(record, newValue)
        reviewedEdit.current = null
      }
    },
    [operations],
  )

  const editingStopped = useCallback(() => {
    editingId.current = null
    const rows = Array.from(deferredRows.current.values())
    deferredRows.current.clear()
    if (rows.length && apiRef.current) {
      const transaction = apiRef.current.applyTransaction({ update: rows })
      apiRef.current.refreshCells({
        rowNodes: transaction?.update,
        columns: ['company'],
        force: true,
      })
    }
  }, [])

  const cellFocused = useCallback(
    ({ api, rowIndex }: CellFocusedEvent<PipelineRow>) => {
      if (rowIndex !== null) {
        const id = api.getDisplayedRowAtIndex(rowIndex)?.id
        if (id) onActiveDealChange(id)
      }
    },
    [onActiveDealChange],
  )

  function refreshList(restoreFocus = true) {
    const api = apiRef.current
    if (!api) return
    const focus = api.getFocusedCell()
    const id = focus ? api.getDisplayedRowAtIndex(focus.rowIndex)?.id : undefined
    api.stopEditing(true)
    editingStopped()
    api.refreshClientSideRowModel('filter')
    resetRefresh()
    if (!restoreFocus) return
    const node = id ? api.getRowNode(id) : undefined
    const index =
      node?.rowIndex ?? (focus ? Math.min(focus.rowIndex, api.getDisplayedRowCount() - 1) : -1)
    if (index >= 0 && focus) {
      api.ensureIndexVisible(index)
      api.ensureColumnVisible(focus.column)
      api.setFocusedCell(index, focus.column)
    } else document.getElementById('company-search')?.focus()
  }

  return (
    <>
      <SelectionBar
        selection={selection}
        service={bulk}
        filters={filters}
        owners={owners}
        stale={listStale}
        searching={searching}
        onSelectAll={() => {
          refreshList(false)
          selection.selectMatching(filters, projection.evaluationTime)
        }}
      />
      {listStale && (
        <div
          className={priorityRefreshPending ? styles.priorityNotice : styles.refreshNotice}
          role="status"
        >
          {priorityRefreshPending
            ? 'Attention priorities changed. Refresh to update this list.'
            : 'Confirmed values updated. Refresh to reapply list ordering and filters.'}
          <button onClick={() => refreshList()}>
            {priorityRefreshPending ? 'Refresh priorities' : 'Refresh list'}
          </button>
        </div>
      )}
      <div className={styles.grid}>
        <AgGridReact<PipelineRow>
          theme={theme}
          rowData={projection.initialRows}
          columnDefs={columns}
          defaultColDef={defaultColumn}
          context={context}
          readOnlyEdit
          onCellEditRequest={requestEdit}
          suppressModelUpdateAfterUpdateTransaction
          rowSelection={rowSelection}
          selectionColumnDef={selectionColumn}
          onRowSelected={rowSelected}
          onCellEditingStopped={editingStopped}
          onCellFocused={cellFocused}
          getRowId={getRowId}
          rowHeight={ROW_HEIGHT}
          headerHeight={46}
          rowBuffer={8}
          animateRows={false}
          ensureDomOrder
          suppressMovableColumns
          suppressMultiSort
          isExternalFilterPresent={isExternalFilterPresent}
          doesExternalFilterPass={passesFilter}
          onGridReady={ready}
          onModelUpdated={modelUpdated}
          onSortChanged={sortChanged}
          onGridPreDestroyed={() => {
            apiRef.current = null
          }}
          overlayComponentParams={overlayParams}
        />
      </div>
    </>
  )
}
