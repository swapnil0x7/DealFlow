import { useLayoutEffect, useRef } from 'react'
import styles from './ViewSwitcher.module.css'

interface ViewOption<Value extends string> {
  value: Value
  label: string
  count: string
}

export function ViewSwitcher<Value extends string>({
  value,
  options,
  onValueChange,
  'aria-label': label,
}: {
  value: Value
  options: readonly ViewOption<Value>[]
  onValueChange: (value: Value) => void
  'aria-label': string
}) {
  const group = useRef<HTMLDivElement>(null)
  const indicator = useRef<HTMLSpanElement>(null)
  useLayoutEffect(() => {
    const element = group.current
    const marker = indicator.current
    if (!element || !marker) return
    const update = () => {
      const selected = element.querySelector<HTMLButtonElement>('[aria-pressed="true"]')
      if (!selected) return
      marker.style.width = `${selected.offsetWidth}px`
      marker.style.translate = `${selected.offsetLeft}px ${selected.offsetTop + selected.offsetHeight - 3}px`
      marker.style.visibility = 'visible'
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    element.querySelectorAll('button').forEach((button) => observer.observe(button))
    return () => observer.disconnect()
  }, [value, options])

  return (
    <div ref={group} className={styles.views} role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onValueChange(option.value)}
        >
          {option.label}
          <span>{option.count}</span>
        </button>
      ))}
      <span ref={indicator} className={styles.indicator} aria-hidden="true" />
    </div>
  )
}
