import { createStore } from 'zustand/vanilla'
import type { Deal } from '../../domain/deal'
import type { BulkPreview } from '../bulk/types'

export type ChangesTarget = { kind: 'history'; filter: 'all' | 'needs-action' } |
  { kind: 'single'; id: string; reviewed?: Deal } |
  { kind: 'bulk-item'; id: string; reviewed?: Deal } | { kind: 'bulk-group'; id: string }

export function createChangesController() {
  let focusHandler: (() => void) | undefined
  const focusPanel = () => focusHandler?.()
  const viewKey = (target: ChangesTarget) => `${target.kind}:${'id' in target ? target.id : ''}:${'reviewed' in target ? target.reviewed?.version ?? '' : ''}`
  const store = createStore<{ open: boolean; target: ChangesTarget; invoker: HTMLElement | null; returnFor?: string; returnLabel?: string | null; undo: BulkPreview | null }>(() => ({
    open: false, target: { kind: 'history', filter: 'all' }, invoker: null, undo: null,
  }))
  return {
    store,
    focusPanel,
    registerFocus(handler: () => void) {
      focusHandler = handler
      return () => { if (focusHandler === handler) focusHandler = undefined }
    },
    open(target: ChangesTarget, invoker?: HTMLElement) {
      const current = store.getState()
      store.setState({ open: true, target, ...(invoker ? { invoker, returnFor: invoker.dataset.recoveryFor, returnLabel: invoker.getAttribute('aria-label') } : {}) })
      if (current.open && (invoker || viewKey(target) !== viewKey(current.target))) focusPanel()
    },
    close() { store.setState({ open: false }) },
    confirmUndo(preview: BulkPreview, invoker: HTMLElement) {
      store.setState({ undo: preview, invoker, returnFor: invoker.dataset.recoveryFor, returnLabel: invoker.getAttribute('aria-label') })
    },
    closeUndo() { store.setState({ undo: null }) },
    returnFocus() {
      const { invoker, returnFor, returnLabel } = store.getState()
      const usable = (element: HTMLElement) => !element.hasAttribute('disabled') &&
        element.dataset.recoveryFor === returnFor && element.getAttribute('aria-label') === returnLabel
      if (invoker?.isConnected && usable(invoker)) return invoker
      // Grid editors may remount their renderer. Recover the same action by identity, never by row index.
      if (returnFor) {
        const replacement = Array.from(document.querySelectorAll<HTMLElement>('[data-row-recovery] [data-recovery-for]')).find(usable)
        if (replacement) return replacement
      }
      return document.getElementById('changes-trigger')
    },
  }
}
export type ChangesController = ReturnType<typeof createChangesController>
