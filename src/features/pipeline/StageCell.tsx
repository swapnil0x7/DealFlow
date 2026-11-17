import { useLayoutEffect, useRef } from 'react'
import type { ComponentProps, ReactNode } from 'react'
import { useStore } from 'zustand'
import { useGridCellEditor } from 'ag-grid-react'
import type { CustomCellEditorProps } from 'ag-grid-react'
import type { ICellRendererParams } from 'ag-grid-community'
import { STAGES, STAGE_LABELS, isStage } from '../../domain/deal'
import type { Stage } from '../../domain/deal'
import { Dropdown } from '../../shared/ui/Dropdown'
import { CommandActions } from '../operations/CommandActions'
import { activityLabel } from '../operations/presentation'
import { useActivity } from '../operations/use-activity'
import changesStyles from '../operations/Changes.module.css'
import type { OperationService } from '../operations/service'
import type { PipelineRow } from './projection'
import type { TableContext } from './table-context'
import styles from './Pipeline.module.css'

const stageOptions = STAGES.map((stage) => ({ value: stage, label: STAGE_LABELS[stage] }))

/** The renderer and editor share the same trigger markup and layout. */
function StageControl({ stage, ...props }: ComponentProps<'button'> & { stage: Stage }) {
  return (
    <button
      {...props}
      type="button"
      className={`${styles.stage} ${styles.stageTrigger} ${styles[stage]}`}
    >
      <span className={styles.stageLabel}>{STAGE_LABELS[stage]}</span>
      <svg className={styles.stageChevron} viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="m3.5 6 4.5 4.5L12.5 6" />
      </svg>
    </button>
  )
}

function StageFrame({
  dealId,
  operations,
  children,
}: {
  dealId: string
  operations: OperationService
  children: ReactNode
}) {
  const item = useActivity(operations.activity, dealId)
  return (
    <div
      className={styles.stageCell}
      data-testid="stage-feedback"
      data-state={item?.status ?? 'confirmed'}
      data-has-actions={Boolean(item)}
    >
      {children}
      {item && (
        <div className={changesStyles.rowRecovery}>
          {(item.status === 'queued' || item.status === 'saving') && (
            <span className={styles.rowPending} title={activityLabel(item)}>
              {item.status === 'queued' ? 'Queued' : 'Saving…'}
            </span>
          )}
          <CommandActions id={item.id} dealId={item.dealId} />
        </div>
      )}
    </div>
  )
}

export function StageCell({
  data,
  context,
  api,
  node,
}: ICellRendererParams<PipelineRow, unknown, TableContext>) {
  // Bulk reservations publish through the same per-deal activity subscription.
  useActivity(context.operations.activity, data?.deal.id ?? '')
  const expired = useStore(context.operations.store, (state) => state.sessionExpired)
  const blocked = expired || Boolean(data && context.operations.isBlocked(data.deal.id))
  return (
    data && (
      <StageFrame dealId={data.deal.id} operations={context.operations}>
        <StageControl
          stage={data.deal.stage}
          tabIndex={-1}
          disabled={blocked}
          aria-haspopup="listbox"
          aria-label={`Change stage for ${data.deal.companyName}. Current stage: ${STAGE_LABELS[data.deal.stage]}`}
          title={
            expired
              ? 'Reload the workspace to edit stages.'
              : blocked
                ? 'Wait for the current change to be resolved before editing.'
                : 'Change stage · Enter or F2'
          }
          data-testid="deal-stage"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ' ') event.stopPropagation()
          }}
          onClick={(event) => {
            event.stopPropagation()
            if (node.rowIndex === null || context.operations.isBlocked(data.deal.id)) return
            api.setFocusedCell(node.rowIndex, 'stage')
            api.startEditingCell({ rowIndex: node.rowIndex, colKey: 'stage', key: 'Enter' })
          }}
        />
      </StageFrame>
    )
  )
}

export function StageEditor({
  data,
  context,
  value,
  initialValue,
  onValueChange,
  stopEditing,
  eventKey,
  eGridCell,
}: CustomCellEditorProps<PipelineRow, Stage, TableContext>) {
  const trigger = useRef<HTMLButtonElement>(null)
  const finished = useRef(false)
  const stage = value ?? initialValue
  useGridCellEditor({
    focusIn: () => trigger.current?.focus({ preventScroll: true }),
  })
  useLayoutEffect(() => {
    if (eventKey !== 'Enter') trigger.current?.focus({ preventScroll: true })
  }, [eventKey])
  const finish = () => {
    if (finished.current) return
    finished.current = true
    stopEditing(true)
  }
  if (!data || !isStage(stage)) return null
  return (
    <StageFrame dealId={data.deal.id} operations={context.operations}>
      <Dropdown
        aria-label={`Change stage for ${data.deal.companyName}. Current stage: ${STAGE_LABELS[stage]}`}
        value={stage}
        options={stageOptions}
        defaultOpen={eventKey === 'Enter'}
        triggerRef={trigger}
        onOpenChange={(open) => {
          if (!open) finish()
        }}
        trigger={<StageControl stage={stage} />}
        popupClassName="ag-custom-component-popup"
        popupMinWidth={180}
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          if (eGridCell.isConnected && document.activeElement === document.body)
            eGridCell.focus({ preventScroll: true })
        }}
        onValueChange={(next) => {
          onValueChange(next)
          // The grid retains the original captured version and owns the save request.
          finish()
        }}
      />
    </StageFrame>
  )
}
