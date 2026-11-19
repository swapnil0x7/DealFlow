import { afterEach, describe, expect, it, vi } from 'vitest'
import { localDayWindow, updatedOnDay } from './calendar'
import { deal } from '../test/fixtures'
import { DEFAULT_FILTERS, matchesFilters } from './filters'
import { PipelineProjection } from '../features/pipeline/projection'

afterEach(() => vi.unstubAllEnvs())

describe('local calendar tracking', () => {
  it('uses local midnight, includes every stage, and excludes the next midnight', () => {
    vi.stubEnv('TZ', 'Asia/Kolkata')
    const day = localDayWindow(Date.parse('2026-11-18T08:00:00Z'))
    expect(new Date(day.start).toISOString()).toBe('2026-11-17T18:30:00.000Z')
    expect(new Date(day.end).toISOString()).toBe('2026-11-18T18:30:00.000Z')
    expect(
      updatedOnDay({ ...deal, stage: 'won', updatedAt: new Date(day.start).toISOString() }, day),
    ).toBe(true)
    expect(updatedOnDay({ ...deal, updatedAt: new Date(day.start - 1).toISOString() }, day)).toBe(
      false,
    )
    expect(updatedOnDay({ ...deal, updatedAt: new Date(day.end).toISOString() }, day)).toBe(false)
  })

  it('uses calendar boundaries through daylight-saving changes', () => {
    vi.stubEnv('TZ', 'America/New_York')
    const spring = localDayWindow(Date.parse('2026-03-08T16:00:00Z'))
    const fall = localDayWindow(Date.parse('2026-11-01T16:00:00Z'))
    expect(spring.end - spring.start).toBe(23 * 3_600_000)
    expect(fall.end - fall.start).toBe(25 * 3_600_000)
  })

  it('updates today counts and publishes membership on midnight and backwards clock changes', () => {
    vi.stubEnv('TZ', 'UTC')
    const now = Date.parse('2026-11-18T23:59:59Z')
    const record = { ...deal, updatedAt: '2026-11-18T10:00:00Z' }
    const projection = new PipelineProjection([record], [], now)
    expect(projection.getCounts().today).toBe(1)
    projection.refreshTime(now + 1000)
    expect(projection.getCounts().today).toBe(0)
    projection.refreshTime(now)
    expect(projection.getCounts().today).toBe(1)
    projection.apply([{ ...record, updatedAt: '2026-11-17T10:00:00Z', version: 2 }])
    expect(projection.getCounts().today).toBe(0)
  })

  it('composes today with search, owner, and stage independently of attention', () => {
    const row = {
      deal: { ...deal, stage: 'won' as const },
      searchName: 'atlas',
      attention: null,
      updatedToday: true,
    }
    const filters = {
      ...DEFAULT_FILTERS,
      view: 'today' as const,
      ownerId: deal.ownerId,
      stage: 'won' as const,
      search: 'Atlas',
    }
    expect(matchesFilters(row, filters)).toBe(true)
    expect(matchesFilters({ ...row, updatedToday: false }, filters)).toBe(false)
    expect(matchesFilters(row, { ...filters, ownerId: 'other' })).toBe(false)
  })
})

it('ends at the next midnight even when daylight saving skips the current midnight', () => {
  vi.stubEnv('TZ', 'America/Santiago')
  const day = localDayWindow(Date.parse('2026-09-06T16:00:00Z'))
  expect(new Date(day.start).getHours()).toBe(1)
  expect(new Date(day.end).getHours()).toBe(0)
  expect(day.end - day.start).toBe(23 * 3_600_000)
})
