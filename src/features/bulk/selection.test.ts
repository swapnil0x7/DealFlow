import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_FILTERS } from '../../domain/filters'
import { seedDeals } from '../../mocks/seed'
import { clock, deal, NOW, owners } from '../../test/fixtures'
import { ConfirmedReadModel } from '../collaboration/read-model'
import { SelectionService, describeCriteria } from './selection'

describe('reviewed selection', () => {
  it('changes one member of a 50,000-deal selection without rescanning reviewed records', () => {
    const model = new ConfirmedReadModel(seedDeals({ clock }).deals)
    const selection = new SelectionService(model)
    selection.selectMatching(DEFAULT_FILTERS, NOW)
    const record = model.all()[0]
    const total = selection.store.getState().totalValuePaise
    model.apply([{ ...record, version: 2, valuePaise: record.valuePaise + 100 }])
    const get = vi.spyOn(model, 'get')
    const change = vi.fn()
    selection.subscribe(change)
    selection.setSelected(record, false, DEFAULT_FILTERS)
    expect(get).not.toHaveBeenCalled()
    expect(selection.store.getState()).toMatchObject({
      count: 49_999,
      totalValuePaise: total - record.valuePaise,
      changed: 0,
    })
    expect(change).toHaveBeenLastCalledWith({ added: [], removed: [record.id] })
    selection.setSelected(
      { ...record, version: 2, valuePaise: record.valuePaise + 100 },
      true,
      DEFAULT_FILTERS,
    )
    expect(get).toHaveBeenCalledTimes(1)
    expect(selection.store.getState()).toMatchObject({
      count: 50_000,
      totalValuePaise: total + 100,
      changed: 0,
    })
    expect(change).toHaveBeenLastCalledWith({ added: [record.id], removed: [] })
    selection.dispose()
  })

  it('captures thousands of matching off-screen IDs from the read model with shared AND predicates', () => {
    const model = new ConfirmedReadModel(seedDeals({ clock }).deals)
    const selection = new SelectionService(model)
    selection.selectMatching({ ...DEFAULT_FILTERS, stage: 'new-lead' }, NOW)
    expect(selection.store.getState().count).toBe(12_000)
    expect(selection.records().every((record) => record.stage === 'new-lead')).toBe(true)
    selection.selectMatching(
      { ...DEFAULT_FILTERS, search: 'cedar', ownerId: 'owner-1', stage: 'contacted' },
      NOW,
    )
    expect(selection.store.getState().count).toBe(250)
    expect(
      selection
        .records()
        .every(
          (record) =>
            record.companyName.startsWith('Cedar') &&
            record.ownerId === 'owner-1' &&
            record.stage === 'contacted',
        ),
    ).toBe(true)
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
    model.apply([
      { ...first, stage: 'lost', version: 2 },
      { ...second, stage: 'new-lead', version: 2 },
    ])
    expect(selection.records()).toEqual([first])
    expect(selection.store.getState()).toMatchObject({
      count: 1,
      changed: 1,
      totalValuePaise: first.valuePaise,
    })
    selection.setMembership([{ ...first, stage: 'lost', version: 2 }], filters)
    expect(selection.records()[0]).toBe(reviewed)
    model.apply([
      { ...second, version: 3, stage: 'new-lead' },
      { ...first, version: 3, stage: 'negotiation' },
    ])
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
    expect(selection.store.getState()).toMatchObject({
      count: 0,
      changed: 0,
      source: null,
      notice: 'Owner filter changed. Selection cleared.',
    })
    selection.dispose()
  })

  it('describes the actual captured criteria and stops observing after disposal', () => {
    expect(
      describeCriteria({ view: 'mine', search: 'atlas', ownerId: 'owner-2', stage: 'won' }, owners),
    ).toBe('My deals · company contains “atlas” · owner: Diya · stage: Won')
    const model = new ConfirmedReadModel([deal])
    const selection = new SelectionService(model)
    selection.selectMatching(DEFAULT_FILTERS, NOW)
    selection.dispose()
    model.apply([{ ...deal, version: 2 }])
    expect(selection.store.getState().changed).toBe(0)
  })
})

it('cooperative selection fixes membership and versions before a teammate update and publishes atomically', async () => {
  const records = Array.from({ length: 1000 }, (_, index) => ({ ...deal, id: `row-${index}` }))
  const model = new ConfirmedReadModel(records)
  const selection = new SelectionService(model)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.stubGlobal('scheduler', {
    yield: vi
      .fn()
      .mockImplementationOnce(() => gate)
      .mockResolvedValue(undefined),
  })
  try {
    const changes = vi.fn()
    selection.subscribe(changes)
    const result = selection.prepareMatching(
      { ...DEFAULT_FILTERS, stage: 'new-lead' },
      NOW,
      new AbortController().signal,
    )
    expect(selection.store.getState().count).toBe(0)
    model.apply([{ ...records[900], stage: 'won', version: 2 }])
    release()
    await result
    expect(selection.records()).toHaveLength(1000)
    expect(selection.records()[900].version).toBe(1)
    expect(selection.store.getState().changed).toBe(1)
    expect(changes).toHaveBeenCalledTimes(1)
  } finally {
    selection.dispose()
    vi.unstubAllGlobals()
  }
})

it('clearing or disposing selection cancels obsolete preparation without publishing partial membership', async () => {
  const model = new ConfirmedReadModel(
    Array.from({ length: 1000 }, (_, index) => ({ ...deal, id: `row-${index}` })),
  )
  const selection = new SelectionService(model)
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  vi.stubGlobal('scheduler', {
    yield: vi
      .fn()
      .mockImplementationOnce(() => gate)
      .mockResolvedValue(undefined),
  })
  try {
    const result = selection.prepareMatching(DEFAULT_FILTERS, NOW, new AbortController().signal)
    const rejected = expect(result).rejects.toMatchObject({ name: 'AbortError' })
    selection.clear('Filters changed.')
    release()
    await rejected
    expect(selection.store.getState().count).toBe(0)
    expect(selection.records()).toEqual([])
  } finally {
    selection.dispose()
    vi.unstubAllGlobals()
  }
})
