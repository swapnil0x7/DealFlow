import { useEffect, useRef, useState } from 'react'

/** Coalesce fast-changing results into at most one polite announcement per interval; no idle timer. */
export function useAnnouncement(message: string, delay = 1_000): string {
  const [announced, setAnnounced] = useState('')
  const latest = useRef(message)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    latest.current = message
    if (timer.current === undefined)
      timer.current = setTimeout(() => {
        timer.current = undefined
        setAnnounced(latest.current)
      }, delay)
  }, [message, delay])
  useEffect(
    () => () => {
      clearTimeout(timer.current)
      timer.current = undefined
    },
    [],
  )
  return announced
}
