import type { Deal } from '../../domain/deal'
import type { PipelineFilters } from '../../domain/filters'
import type { OperationService } from '../operations/service'
import type { SelectionService } from '../bulk/selection'

export interface TableContext {
  operations: OperationService
  selection: SelectionService
  filters: PipelineFilters
  captureEdit: (record: Deal) => void
}
