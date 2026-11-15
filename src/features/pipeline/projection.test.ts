import { expect, it, vi } from 'vitest'
import { seedDeals } from '../../mocks/seed'
import { clock, NOW } from '../../test/fixtures'
import { DEFAULT_FILTERS, matchesFilters } from '../../domain/filters'
import { PipelineProjection, projectPipeline } from './projection'
import { data, deal } from '../../test/fixtures'

it('indexes the full dataset and agrees on view/filter membership independently of mounted rows', () => {
  const { deals, owners } = seedDeals({ clock })
  const { rows, counts } = projectPipeline(deals, owners, NOW)
  expect(counts.all).toBe(50_000)
  expect(counts.mine).toBe(2_500)
  expect(counts.attention).toBe(rows.filter((row) => matchesFilters(row, { ...DEFAULT_FILTERS, view: 'attention' })).length)
  const filtered = rows.filter((row) => matchesFilters(row, { view: 'all', search: 'cedar', ownerId: 'owner-1', stage: 'contacted' }))
  expect(filtered.map((row) => row.deal.id)).toEqual(deals.filter((record) => record.companyName.toLowerCase().includes('cedar') && record.ownerId === 'owner-1' && record.stage === 'contacted').map((record) => record.id))
  expect(filtered.length).toBeGreaterThan(0)
  expect(rows[0].ownerName).toBe(owners[0].name)
})

it('publishes only affected rows and adjusts counters without rebuilding the initial row array', () => {
  const source = data()
  const projection = new PipelineProjection(source.deals, source.owners, NOW)
  const initial = projection.initialRows
  const rows = vi.fn()
  const counts = vi.fn()
  const unsubscribe = projection.subscribeRows(rows)
  projection.subscribeCounts(counts)
  const before = projection.getCounts()
  projection.apply([{ ...deal, stage: 'won', version: 2 }])
  expect(rows).toHaveBeenCalledTimes(1)
  expect(rows.mock.calls[0][0]).toHaveLength(1)
  expect(projection.getCounts()).toEqual({ ...before, attention: before.attention - 1 })
  expect(projection.initialRows).toBe(initial)
  expect(initial[0].deal.version).toBe(1)
  projection.apply([deal])
  expect(rows).toHaveBeenCalledTimes(1)
  expect(counts).toHaveBeenCalledTimes(1)
  unsubscribe()
  projection.apply([{ ...deal, stage: 'lost', version: 3 }])
  expect(rows).toHaveBeenCalledTimes(1)
})
