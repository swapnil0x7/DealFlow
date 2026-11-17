import { useCallback, useEffect, useId, useImperativeHandle, useLayoutEffect, useRef } from 'react'
import type { FocusEvent, KeyboardEvent, ReactNode, Ref } from 'react'
import { createPortal } from 'react-dom'
import * as Dialog from '@radix-ui/react-dialog'
import { useMediaQuery } from '../use-media-query'
import styles from './SidePanel.module.css'

export interface SidePanelHandle {
  focusHeading: () => void
  getFocusTarget: () => HTMLElement | null
}

interface SidePanelProps {
  ref?: Ref<SidePanelHandle>
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  returnFocus: () => HTMLElement | null
  children: ReactNode
  closeLabel?: string
}

/** Desktop leaves background input alone. Mobile uses Radix's focus trap and modal isolation. */
export function SidePanel({
  ref,
  open,
  onOpenChange,
  title,
  description,
  returnFocus,
  children,
  closeLabel = 'Close panel',
}: SidePanelProps) {
  const compact = useMediaQuery('(max-width: 767px)')
  const titleId = useId()
  const descriptionId = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const restore = useRef(returnFocus)
  const focused = useRef<{ element: HTMLElement; fallback: HTMLElement | null } | null>(null)
  const restoreAfterClose = useCallback(() => {
    // Inspect the current node, since a responsive replacement may have mounted after cleanup.
    if (!content.current) restore.current()?.focus({ preventScroll: true })
  }, [])
  useImperativeHandle(
    ref,
    () => ({
      focusHeading: () => heading.current?.focus({ preventScroll: true }),
      getFocusTarget: () => heading.current,
    }),
    [],
  )
  useLayoutEffect(() => {
    restore.current = returnFocus
  }, [returnFocus])
  useLayoutEffect(() => {
    if (!open) return
    heading.current?.focus({ preventScroll: true })
    return () => {
      // Mode changes mount a replacement. Only restore the invoker after an actual close.
      queueMicrotask(restoreAfterClose)
    }
  }, [open, compact, restoreAfterClose])
  useEffect(() => {
    const element = content.current
    if (!open || !element) return
    const observer = new MutationObserver(() => {
      const previous = focused.current
      if (previous && !previous.element.isConnected && document.activeElement === document.body) {
        focused.current = null
        const target = previous.fallback?.isConnected ? previous.fallback : heading.current
        target?.focus({ preventScroll: true })
      }
    })
    observer.observe(element, { childList: true, subtree: true })
    return () => {
      observer.disconnect()
      focused.current = null
    }
  }, [open, compact])

  const onFocusCapture = (event: FocusEvent<HTMLDivElement>) => {
    if (content.current?.contains(event.target))
      focused.current = {
        element: event.target as HTMLElement,
        fallback: (event.target as HTMLElement).closest<HTMLElement>('[data-focus-fallback]'),
      }
  }
  const onBlurCapture = () => {
    const previous = focused.current
    // A removal can dispatch blur before detaching the node. Wait for the DOM commit.
    queueMicrotask(() => {
      if (
        focused.current === previous &&
        previous?.element.isConnected &&
        !content.current?.contains(document.activeElement)
      )
        focused.current = null
    })
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (compact || event.defaultPrevented) return
    if (event.key === 'Escape' && event.currentTarget.contains(event.target as Node)) {
      event.preventDefault()
      event.stopPropagation()
      onOpenChange(false)
    }
    if (event.key !== 'Tab') return
    const controls = Array.from(
      event.currentTarget.querySelectorAll<HTMLElement>(
        'button, a[href], input, select, textarea, [tabindex="0"]',
      ),
    ).filter(
      (element) =>
        element.tabIndex >= 0 &&
        !element.hasAttribute('disabled') &&
        element.getClientRects().length > 0,
    )
    if (document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))) {
      event.preventDefault()
      returnFocus()?.focus({ preventScroll: true })
    }
  }
  if (!open) return null

  const body = (
    <>
      <div className={styles.header}>
        <div>
          {compact ? (
            <Dialog.Title ref={heading} id={titleId} tabIndex={-1}>
              {title}
            </Dialog.Title>
          ) : (
            <h2 ref={heading} id={titleId} tabIndex={-1}>
              {title}
            </h2>
          )}
          {compact ? (
            <Dialog.Description id={descriptionId}>{description}</Dialog.Description>
          ) : (
            <p id={descriptionId}>{description}</p>
          )}
        </div>
        <button
          type="button"
          className={styles.close}
          aria-label={closeLabel}
          onClick={() => onOpenChange(false)}
        >
          <svg viewBox="0 0 20 20" aria-hidden="true">
            <path d="m5 5 10 10M15 5 5 15" />
          </svg>
        </button>
      </div>
      <div className={styles.body}>{children}</div>
    </>
  )
  const props = {
    ref: content,
    className: styles.panel,
    'data-side-panel': true,
    'data-compact': compact,
    'data-state': 'open',
    'aria-labelledby': titleId,
    'aria-describedby': descriptionId,
    onFocusCapture,
    onBlurCapture,
    onKeyDown,
  }
  return compact ? (
    <Dialog.Root open onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content
          {...props}
          aria-modal="true"
          onInteractOutside={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => {
            event.preventDefault()
            heading.current?.focus({ preventScroll: true })
          }}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          {body}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  ) : (
    createPortal(
      <div {...props} role="dialog" tabIndex={-1}>
        {body}
      </div>,
      document.body,
    )
  )
}
