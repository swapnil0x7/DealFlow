import { describe, expect, it, vi } from 'vitest'
import { deal } from '../../test/fixtures'
import { ConfirmedReadModel } from './read-model'

describe('confirmed read model (T05 foundation)', () => {
  it('ignores older/equal versions, including stale arrivals in a mixed batch', () => {
    const model = new ConfirmedReadModel([deal])
    const listener = vi.fn()
    model.subscribe(listener)
    const changes = model.apply([
      { ...deal, version: 3, stage: 'won' },
      { ...deal, version: 2, stage: 'lost' },
      { ...deal, version: 3, stage: 'contacted' },
    ])
    expect(changes).toHaveLength(1)
    expect(model.get(deal.id)).toMatchObject({ version: 3, stage: 'won' })
    expect(listener).toHaveBeenCalledTimes(1)
    expect(model.apply([deal])).toEqual([])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('freezes isolated snapshots and caches the all-record view until a real change', () => {
    const source = { ...deal }
    const model = new ConfirmedReadModel([source])
    const initial = model.all()
    Object.assign(source, { version: 99 })
    expect(model.get(deal.id)?.version).toBe(1)
    expect(() => Object.assign(model.get(deal.id)!, { version: 20 })).toThrow()
    expect(Object.isFrozen(initial)).toBe(true)
    model.apply([deal])
    expect(model.all()).toBe(initial)
    model.apply([{ ...deal, id: 'another' }])
    expect(model.size).toBe(2)
    expect(model.all()).not.toBe(initial)
    expect(initial).toHaveLength(1)
  })

  it('publishes the final version once per ID and supports unsubscribing', () => {
    const model = new ConfirmedReadModel([deal])
    const listener = vi.fn()
    const unsubscribe = model.subscribe(listener)
    model.apply([
      { ...deal, version: 2 },
      { ...deal, version: 4 },
    ])
    expect(listener.mock.calls[0][0]).toEqual([{ ...deal, version: 4 }])
    unsubscribe()
    model.apply([{ ...deal, version: 5 }])
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
