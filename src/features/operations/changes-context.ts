import { createContext, useContext } from 'react'
import type { BulkService } from '../bulk/service'
import type { ConfirmedReadModel } from '../collaboration/read-model'
import type { OperationService } from './service'
import type { ChangesController } from './changes-controller'

export interface ChangesServices {
  controller: ChangesController
  operations: OperationService
  bulk: BulkService
  model: ConfirmedReadModel
}
export const ChangesContext = createContext<ChangesServices | null>(null)
export function useChanges(): ChangesServices {
  const value = useContext(ChangesContext)
  if (!value) throw new Error('Changes controls require ChangesProvider')
  return value
}
