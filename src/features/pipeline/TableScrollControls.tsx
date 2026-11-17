import type { RefObject } from 'react'
import { Button } from '../../shared/ui/Button'
import styles from './TableScrollControls.module.css'

/** Smooth explicit page steps, leaving AG Grid's native wheel and keyboard scrolling alone. */
export function TableScrollControls({ host }: { host: RefObject<HTMLDivElement | null> }) {
  function scroll(direction: number) {
    // AG Grid 36's main viewport owns virtual row scrolling, including pinned rows.
    const viewport = host.current?.querySelector<HTMLElement>('.ag-grid-viewport')
    if (!viewport) return
    viewport.scrollBy({
      top: direction * viewport.clientHeight * 0.85,
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ? 'instant'
        : 'smooth',
    })
  }
  return (
    <div className={styles.controls} role="group" aria-label="Scroll deals">
      {([-1, 1] as const).map((direction) => (
        <Button
          key={direction}
          variant="ghost"
          aria-label={direction === -1 ? 'Scroll deals up' : 'Scroll deals down'}
          title={direction === -1 ? 'Scroll deals up' : 'Scroll deals down'}
          onClick={() => scroll(direction)}
        >
          <svg viewBox="0 0 16 16" fill="none" aria-hidden="true" data-direction={direction}>
            <path d="m4 10 4-4 4 4" />
          </svg>
        </Button>
      ))}
    </div>
  )
}
