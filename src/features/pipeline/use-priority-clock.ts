import { useEffect } from 'react'
import type { PipelineProjection } from './projection'

/** Local clock checks only. Suspend in background tabs and catch up against wall time on return. */
export function usePriorityClock(projection: PipelineProjection): void {
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const check = () => {
      clearTimeout(timer)
      if (document.hidden) return
      projection.refreshTime(Date.now())
      timer = setTimeout(check, 60_000)
    }
    check()
    document.addEventListener('visibilitychange', check)
    window.addEventListener('focus', check)
    window.addEventListener('pageshow', check)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', check)
      window.removeEventListener('focus', check)
      window.removeEventListener('pageshow', check)
    }
  }, [projection])
}
