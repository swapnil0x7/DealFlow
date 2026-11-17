import { useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { ChangesContext } from './changes-context'
import type { ChangesServices } from './changes-context'
import { createChangesController } from './changes-controller'
import { ChangesPanel } from './ChangesPanel'

export function ChangesProvider({ operations, bulk, model, children }: Omit<ChangesServices, 'controller'> & { children: ReactNode }) {
  const [controller] = useState(createChangesController)
  const value = useMemo(() => ({ operations, bulk, model, controller }), [operations, bulk, model, controller])
  return <ChangesContext.Provider value={value}>{children}<ChangesPanel /></ChangesContext.Provider>
}
