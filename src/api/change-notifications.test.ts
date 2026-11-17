import { describe, expect, it, vi } from 'vitest'
import { ChangeNotificationChannel } from './change-notifications'

describe('fake API notification transport', () => {
  it('delivers immutable hints to subscribers and releases removed listeners', () => {
    const channel = new ChangeNotificationChannel()
    const listener = vi.fn()
    const stop = channel.subscribe(listener)
    channel.publish({ kind: 'changes', sessionId: 'session-1', cursor: 1 })
    expect(listener).toHaveBeenCalledWith({ kind: 'changes', sessionId: 'session-1', cursor: 1 })
    expect(Object.isFrozen(listener.mock.calls[0][0])).toBe(true)
    stop(); stop()
    channel.publish({ kind: 'reset', sessionId: 'session-2' })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('isolates a failing observer so other clients still receive commit notifications', () => {
    const channel = new ChangeNotificationChannel()
    channel.subscribe(() => { throw new Error('Broken consumer') })
    const listener = vi.fn()
    channel.subscribe(listener)
    expect(() => channel.publish({ kind: 'configuration', sessionId: 'session-1' })).not.toThrow()
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
