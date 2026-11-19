import { useCallback, useEffect, useRef, useState } from 'react'

/** Own cancellable UI preparation independently of confirmed commands and records. */
export function usePreparation() {
  const current = useRef<AbortController | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const cancel = useCallback(() => {
    current.current?.abort()
    current.current = null
    setBusy(false)
  }, [])
  useEffect(
    () => () => {
      current.current?.abort()
      current.current = null
    },
    [],
  )
  const run = useCallback(async <T>(action: (signal: AbortSignal) => Promise<T>) => {
    current.current?.abort()
    const controller = new AbortController()
    current.current = controller
    setBusy(true)
    setError('')
    try {
      const value = await action(controller.signal)
      if (!controller.signal.aborted) return value
    } catch (cause) {
      if (
        !controller.signal.aborted &&
        !(cause instanceof DOMException && cause.name === 'AbortError')
      )
        setError(cause instanceof Error ? cause.message : 'Preparation failed. Try again.')
    } finally {
      if (current.current === controller) {
        current.current = null
        setBusy(false)
      }
    }
  }, [])
  return { busy, error, run, cancel }
}
