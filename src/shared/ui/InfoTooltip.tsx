import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import styles from './InfoTooltip.module.css'

/** Non-interactive help, available on hover, focus, or a persistent tap/click. */
export function InfoTooltip({ label, children }: { label: string; children: ReactNode }) {
  const id = useId()
  const [open, setOpen] = useState(false)
  const [container, setContainer] = useState<Element | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const content = useRef<HTMLDivElement>(null)
  const pinned = useRef(false)
  const hovered = useRef(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const show = () => {
    clearTimeout(timer.current)
    // Keep supplementary help inside its existing landmark while escaping clipped panels.
    setContainer(trigger.current?.closest('main, header, footer, aside, nav') ?? document.body)
    setOpen(true)
  }
  const hide = () => {
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      if (!pinned.current && !hovered.current && document.activeElement !== trigger.current) setOpen(false)
    }, 120)
  }
  useEffect(() => () => clearTimeout(timer.current), [])
  useLayoutEffect(() => {
    if (!open) return
    const position = () => {
      if (!trigger.current || !content.current) return
      const anchor = trigger.current.getBoundingClientRect()
      const box = content.current.getBoundingClientRect()
      const left = Math.max(12, Math.min(anchor.right - box.width, innerWidth - box.width - 12))
      const preferredTop = anchor.bottom + 10 + box.height <= innerHeight - 12 ? anchor.bottom + 10 : anchor.top - box.height - 10
      Object.assign(content.current.style, {
        left: `${left}px`, top: `${Math.max(12, Math.min(preferredTop, innerHeight - box.height - 12))}px`, visibility: 'visible',
      })
    }
    position()
    const observer = new ResizeObserver(position)
    if (content.current) observer.observe(content.current)
    if (trigger.current) observer.observe(trigger.current)
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => { observer.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true) }
  }, [open])
  useEffect(() => {
    if (!open) return
    const dismiss = () => { pinned.current = false; hovered.current = false; clearTimeout(timer.current); setOpen(false) }
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss() }
    const outside = (event: PointerEvent) => {
      if (!trigger.current?.contains(event.target as Node) && !content.current?.contains(event.target as Node)) dismiss()
    }
    document.addEventListener('keydown', key)
    document.addEventListener('pointerdown', outside, true)
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside, true) }
  }, [open])
  return <>
    <button ref={trigger} type="button" className={styles.trigger} aria-describedby={open ? id : undefined}
      onPointerEnter={(event) => { if (event.pointerType !== 'touch') { hovered.current = true; show() } }} onPointerLeave={() => { hovered.current = false; hide() }}
      onFocus={show} onBlur={() => { pinned.current = false; hide() }}
      onClick={() => { pinned.current = !pinned.current; clearTimeout(timer.current); if (pinned.current) show(); else setOpen(false) }}>
      <svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><circle cx="10" cy="10" r="7.5" /><path d="M10 9v5m0-8v.1" /></svg>
      <span>{label}</span>
    </button>
    {open && createPortal(<div ref={content} id={id} role="tooltip" className={styles.content}
      onPointerEnter={(event) => { if (event.pointerType !== 'touch') hovered.current = true; clearTimeout(timer.current) }}
      onPointerLeave={() => { hovered.current = false; hide() }}>{children}</div>, container ?? document.body)}
  </>
}
