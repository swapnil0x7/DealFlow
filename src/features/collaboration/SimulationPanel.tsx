import { useState } from 'react'
import type { ComponentProps } from 'react'
import { Button } from '../../shared/ui/Button'
import { DeferredContent } from '../../shared/ui/DeferredContent'
import type { SimulationPanelContent } from './SimulationPanelContent'
import styles from './Simulation.module.css'

const loadPanel = () =>
  import('./SimulationPanelContent').then((module) => ({ default: module.SimulationPanelContent }))

export function SimulationPanel(props: ComponentProps<typeof SimulationPanelContent>) {
  const [activated, setActivated] = useState(false)
  const trigger = (
    <Button className={styles.trigger} onClick={() => setActivated(true)}>
      Simulation
    </Button>
  )
  return activated ? (
    <DeferredContent
      load={loadPanel}
      componentProps={props}
      fallback={
        <Button className={styles.trigger} disabled aria-label="Loading simulation controls">
          Simulation
        </Button>
      }
      failure={(retry) => (
        <Button className={styles.trigger} onClick={retry}>
          Retry simulation controls
        </Button>
      )}
    />
  ) : (
    trigger
  )
}
