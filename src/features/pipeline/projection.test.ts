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
  expect(counts.attention).toBe(
    rows.filter((row) => matchesFilters(row, { ...DEFAULT_FILTERS, view: 'attention' })).length,
  )
  const filtered = rows.filter((row) =>
    matchesFilters(row, { view: 'all', search: 'cedar', ownerId: 'owner-1', stage: 'contacted' }),
  )
  expect(filtered.map((row) => row.deal.id)).toEqual(
    deals
      .filter(
        (record) =>
          record.companyName.toLowerCase().includes('cedar') &&
          record.ownerId === 'owner-1' &&
          record.stage === 'contacted',
      )
      .map((record) => record.id),
  )
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

it('quiet clock checks publish nothing when no attention result changes', () => {
  const source = data()
  const projection = new PipelineProjection(source.deals, source.owners, NOW)
  const rows = vi.fn()
  const counts = vi.fn()
  projection.subscribeRows(rows)
  projection.subscribeCounts(counts)
  const initial = projection.initialRows
  const before = projection.getCounts()
  projection.refreshTime(NOW + 60_000)
  projection.refreshTime(NOW + 120_000)
  expect(rows).not.toHaveBeenCalled()
  expect(counts).not.toHaveBeenCalled()
  expect(projection.getCounts()).toBe(before)
  expect(projection.initialRows).toBe(initial)
  expect(projection.evaluationTime).toBe(NOW + 120_000)
})

it('clock catch-up publishes exact membership, urgency and reason changes without changing deal versions', () => {
  const day = 86_400_000
  const records = [
    {
      ...deal,
      id: 'lead',
      createdAt: new Date(NOW - 2 * day + 30_000).toISOString(),
      lastActivityAt: new Date(NOW).toISOString(),
    },
    {
      ...deal,
      id: 'negotiation',
      stage: 'negotiation' as const,
      lastActivityAt: new Date(NOW - 14 * day + 30_000).toISOString(),
    },
    { ...deal, id: 'closed', stage: 'won' as const },
  ]
  const projection = new PipelineProjection(records, data().owners, NOW)
  const rows = vi.fn()
  const counts = vi.fn()
  projection.subscribeRows(rows)
  projection.subscribeCounts(counts)
  projection.refreshTime(NOW + 30_000)
  expect(projection.getCounts().attention).toBe(2)
  expect(counts).toHaveBeenCalledTimes(1)
  const [changed, source] = rows.mock.calls[0]
  expect(source).toBe('time')
  expect(
    changed.map((row: { deal: { id: string }; attention: { reason: string } }) => [
      row.deal.id,
      row.attention.reason,
    ]),
  ).toEqual([
    ['lead', 'New lead waiting 2 days'],
    ['negotiation', 'Negotiation inactive for 14 days'],
  ])
  expect(changed[0].deal).toBe(records[0])
  expect(changed[0].deal.version).toBe(1)
  projection.refreshTime(NOW + 60_000)
  expect(rows).toHaveBeenCalledTimes(1)
  // Sleeping tabs catch up directly against wall time, without replaying every missed minute.
  projection.refreshTime(NOW + 3 * day)
  expect(rows.mock.calls[1][0][0].attention.reason).toBe('New lead waiting 4 days')
  expect(counts).toHaveBeenCalledTimes(1)
})

it('time checks use the newest confirmed records and handle a backwards clock correction', () => {
  const projection = new PipelineProjection(
    [
      {
        ...deal,
        createdAt: new Date(NOW - 86_400_000).toISOString(),
        lastActivityAt: new Date(NOW).toISOString(),
      },
    ],
    data().owners,
    NOW,
  )
  const rows = vi.fn()
  projection.subscribeRows(rows)
  projection.refreshTime(NOW + 86_400_000)
  expect(projection.getCounts().attention).toBe(1)
  projection.refreshTime(NOW)
  expect(projection.getCounts().attention).toBe(0)
  projection.apply([{ ...deal, stage: 'won', version: 2 }])
  rows.mockClear()
  projection.refreshTime(NOW + 10 * 86_400_000)
  expect(rows).not.toHaveBeenCalled()
  expect(projection.getCounts().attention).toBe(0)
})
