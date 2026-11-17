import { describe, expect, it } from 'vitest'
import { DEFAULT_FILTERS } from '../../domain/filters'
import { seedDeals } from '../../mocks/seed'
import { clock, deal, NOW, owners } from '../../test/fixtures'
import { ConfirmedReadModel } from '../collaboration/read-model'
import { SelectionService, describeCriteria } from './selection'

describe('reviewed selection', () => {
  it('captures thousands of matching off-screen IDs from the read model with shared AND predicates', () => {
    const model = new ConfirmedReadModel(seedDeals({ clock }).deals)
    const selection = new SelectionService(model)
    selection.selectMatching({ ...DEFAULT_FILTERS, stage: 'new-lead' }, NOW)
    expect(selection.store.getState().count).toBe(12_000)
    expect(selection.records().every((record) => record.stage === 'new-lead')).toBe(true)
    selection.selectMatching({ ...DEFAULT_FILTERS, search: 'cedar', ownerId: 'owner-1', stage: 'contacted' }, NOW)
    expect(selection.store.getState().count).toBe(250)
    expect(selection.records().every((record) => record.companyName.startsWith('Cedar') && record.ownerId === 'owner-1' && record.stage === 'contacted')).toBe(true)
    selection.dispose()
  })

  it('freezes membership and versions across updates, reordering, refresh and full resync', () => {
    const first = { ...deal }
    const second = { ...deal, id: 'second', stage: 'won' as const }
    const model = new ConfirmedReadModel([first, second])
    const selection = new SelectionService(model)
    const filters = { ...DEFAULT_FILTERS, stage: 'new-lead' as const }
    selection.selectMatching(filters, NOW)
    const reviewed = selection.records()[0]
    model.apply([{ ...first, stage: 'lost', version: 2 }, { ...second, stage: 'new-lead', version: 2 }])
    expect(selection.records()).toEqual([first])
    expect(selection.store.getState()).toMatchObject({ count: 1, changed: 1, totalValuePaise: first.valuePaise })
    selection.setMembership([{ ...first, stage: 'lost', version: 2 }], filters)
    expect(selection.records()[0]).toBe(reviewed)
    model.apply([{ ...second, version: 3, stage: 'new-lead' }, { ...first, version: 3, stage: 'negotiation' }])
    expect(selection.records()[0].version).toBe(1)
    // Selecting the matching set again removes the old nonmatch and explicitly adds the new match.
    selection.selectMatching(filters, NOW)
    expect(selection.records()).toEqual([{ ...second, version: 3, stage: 'new-lead' }])
    expect(selection.store.getState().changed).toBe(0)
    selection.dispose()
  })

  it('only accepts a changed member’s new version after explicit deselection/reselection and announces clearing', () => {
    const model = new ConfirmedReadModel([deal])
    const selection = new SelectionService(model)
    selection.setMembership([deal], DEFAULT_FILTERS)
    const latest = { ...deal, version: 2 }
    model.apply([latest])
    selection.selectMatching(DEFAULT_FILTERS, NOW)
    expect(selection.records()[0].version).toBe(1)
    selection.setMembership([], DEFAULT_FILTERS)
    selection.setMembership([latest], DEFAULT_FILTERS)
    expect(selection.records()[0].version).toBe(2)
    selection.clear('Owner filter changed. Selection cleared.')
    expect(selection.store.getState()).toMatchObject({ count: 0, changed: 0, source: null, notice: 'Owner filter changed. Selection cleared.' })
    selection.dispose()
  })

  it('describes the actual captured criteria and stops observing after disposal', () => {
    expect(describeCriteria({ view: 'mine', search: 'atlas', ownerId: 'owner-2', stage: 'won' }, owners))
      .toBe('My deals · company contains “atlas” · owner: Diya · stage: Won')
    const model = new ConfirmedReadModel([deal])
    const selection = new SelectionService(model)
    selection.selectMatching(DEFAULT_FILTERS, NOW)
    selection.dispose()
    model.apply([{ ...deal, version: 2 }])
    expect(selection.store.getState().changed).toBe(0)
  })
})
