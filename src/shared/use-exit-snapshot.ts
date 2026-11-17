import { useCallback, useState } from 'react'

/** Keep the last open content stable until its exit animation actually unmounts. */
export function useExitSnapshot<T>(value: T | null) {
  const [snapshot, setSnapshot] = useState(value)
  if (value !== null && value !== snapshot) setSnapshot(value)
  const release = useCallback(() => setSnapshot(null), [])
  return [value ?? snapshot, release] as const
}
