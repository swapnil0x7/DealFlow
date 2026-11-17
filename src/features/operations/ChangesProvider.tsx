import { useMemo, useState } from 'react'
import { useStore } from 'zustand'
import type { ReactNode } from 'react'
import { ChangesContext } from './changes-context'
import type { ChangesServices } from './changes-context'
import { createChangesController } from './changes-controller'
import { DeferredContent } from '../../shared/ui/DeferredContent'
import { Button } from '../../shared/ui/Button'
import styles from './Changes.module.css'

const loadPanel = () =>
  import('./ChangesPanel').then((module) => ({ default: module.ChangesPanel }))

export function ChangesProvider({
  operations,
  bulk,
  model,
  children,
}: Omit<ChangesServices, 'controller'> & { children: ReactNode }) {
  const [controller] = useState(createChangesController)
  const value = useMemo(
    () => ({ operations, bulk, model, controller }),
    [operations, bulk, model, controller],
  )
  const needed = useStore(controller.store, (state) => state.requested)
  return (
    <ChangesContext.Provider value={value}>
      {children}
      {needed && (
        <DeferredContent
          load={loadPanel}
          componentProps={{}}
          fallback={
            <span className={styles.srOnly} role="status">
              Loading changes…
            </span>
          }
          failure={(retry) => (
            <div className={styles.workspaceNotice} role="alert">
              Changes could not load. Your session is still available.{' '}
              <Button onClick={retry}>Retry changes panel</Button>
            </div>
          )}
        />
      )}
    </ChangesContext.Provider>
  )
}
