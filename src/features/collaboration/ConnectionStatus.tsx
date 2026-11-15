import { useStore } from 'zustand'
import type { ChangeFeed, ConnectionStatus as Status } from './feed'
import { formatCount } from '../../shared/format'
import styles from './Simulation.module.css'

const LABELS: Record<Status, string> = {
  connecting: 'Connecting live updates', live: 'Live updates connected', paused: 'Live updates paused',
  offline: 'Offline', hidden: 'Updates paused while hidden', reconnecting: 'Reconnecting updates',
  resyncing: 'Resyncing updates', expired: 'Session expired',
}

export function ConnectionStatus({ feed }: { feed: ChangeFeed }) {
  const status = useStore(feed.store, (state) => state.status)
  const received = useStore(feed.store, (state) => state.received)
  const message = useStore(feed.store, (state) => state.message)
  return <div className={styles.connection} title={message}>
    <span role="status" aria-live="polite" data-testid="connection-status">{LABELS[status]}</span>
    <small>{formatCount(received)} updates received</small>
  </div>
}
