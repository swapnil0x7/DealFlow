import { describe, expect, it } from 'vitest'
import { STAGES } from '../domain/deal'
import { NOW, clock } from '../test/fixtures'
import { seedDeals, seededRandom, STAGE_POPULATIONS } from './seed'

describe('deterministic full-volume seed (T01)', () => {
  it('creates valid unique deals with the exact distribution and all twenty owners', () => {
    const { deals, owners } = seedDeals({ clock })
    expect(deals).toHaveLength(50_000)
    expect(new Set(deals.map((deal) => deal.id)).size).toBe(50_000)
    expect(owners).toHaveLength(20)
    expect(new Set(deals.map((deal) => deal.ownerId))).toEqual(
      new Set(owners.map((owner) => owner.id)),
    )
    expect(STAGES.map((stage) => deals.filter((deal) => deal.stage === stage).length)).toEqual([
      ...STAGE_POPULATIONS,
    ])
    expect(deals.some((deal) => deal.lastActivityAt === null)).toBe(true)
    for (const deal of deals) {
      if (
        !Number.isSafeInteger(deal.valuePaise) ||
        deal.valuePaise <= 0 ||
        deal.version !== 1 ||
        Date.parse(deal.createdAt) > NOW ||
        Date.parse(deal.updatedAt) < Date.parse(deal.createdAt) ||
        Date.parse(deal.updatedAt) > NOW ||
        (deal.lastActivityAt !== null &&
          Date.parse(deal.lastActivityAt) < Date.parse(deal.createdAt))
      ) {
        throw new Error(`Invalid seed record: ${deal.id}`)
      }
    }
  })

  it('repeats records for the same seed/clock, varies data for a different seed, and keeps stable IDs', () => {
    const first = seedDeals({ seed: 17, clock })
    expect(seedDeals({ seed: 17, clock })).toEqual(first)
    const second = seedDeals({ seed: 18, clock })
    expect(second.deals[0].id).toBe(first.deals[0].id)
    expect(second.deals[0]).not.toEqual(first.deals[0])
  })

  it('provides repeatable random numbers in [0, 1)', () => {
    const a = seededRandom(42)
    const b = seededRandom(42)
    for (let index = 0; index < 100; index++) {
      const value = a()
      expect(value).toBe(b())
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThan(1)
    }
  })
})
