import { Component, Suspense, lazy, useState } from 'react'
import type { ComponentType, ReactNode } from 'react'

interface BoundaryProps {
  children: ReactNode
  failure: ReactNode
}
class LoadBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  render() {
    return this.state.failed ? this.props.failure : this.props.children
  }
}

/** Optional panels load on demand and can recover locally without discarding the workspace session. */
export function DeferredContent<Props extends object>({
  load,
  componentProps,
  fallback,
  failure,
}: {
  load: () => Promise<{ default: ComponentType<Props> }>
  componentProps: Props
  fallback: ReactNode
  failure: (retry: () => void) => ReactNode
}) {
  const [{ Deferred, attempt }, setContent] = useState(() => ({ Deferred: lazy(load), attempt: 0 }))
  const retry = () =>
    setContent((previous) => ({ Deferred: lazy(load), attempt: previous.attempt + 1 }))
  return (
    <LoadBoundary key={attempt} failure={failure(retry)}>
      <Suspense fallback={fallback}>
        <Deferred {...componentProps} />
      </Suspense>
    </LoadBoundary>
  )
}
