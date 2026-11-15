import { describe, expect, it } from 'vitest'
import { attentionFor, compareAttention } from './attention'
import { deal, NOW } from '../test/fixtures'
import type { Deal } from './deal'

const DAY = 86_400_000
const ago = (days: number) => new Date(NOW - days * DAY).toISOString()
const candidate = (changes: Partial<Deal> = {}): Deal => ({ ...deal, stage: 'contacted', createdAt: ago(30), lastActivityAt: ago(0), ...changes })

describe('explainable attention (T18)', () => {
  it.each([
    ['new-lead', 2, 2, 'New lead waiting 2 days'],
    ['contacted', 7, 1, 'No activity for 7 days'],
    ['negotiation', 14, 3, 'Negotiation inactive for 14 days'],
  ] as const)('includes %s at the exact %i-day threshold', (stage, days, urgency, reason) => {
    const record = candidate({ stage, createdAt: ago(days), lastActivityAt: ago(days) })
    expect(attentionFor(record, NOW)).toMatchObject({ urgency, reason })
    expect(attentionFor(record, NOW - 1)?.urgency === urgency).toBe(false)
  })

  it('uses createdAt for absent activity; a newer stage update never replaces that baseline', () => {
    const record = candidate({ lastActivityAt: null, createdAt: ago(8), updatedAt: ago(0) })
    expect(attentionFor(record, NOW)).toEqual({ urgency: 1, baseline: Date.parse(ago(8)), reason: 'No activity for 8 days' })
  })

  it.each(['won', 'lost'] as const)('excludes closed %s records regardless of age', (stage) => {
    expect(attentionFor(candidate({ stage, lastActivityAt: ago(100) }), NOW)).toBeNull()
  })

  it('prefers new-lead waiting over general inactivity and handles future dates without negative age', () => {
    expect(attentionFor(candidate({ stage: 'new-lead', lastActivityAt: ago(8) }), NOW)?.urgency).toBe(2)
    expect(attentionFor(candidate({ createdAt: ago(-2), lastActivityAt: null }), NOW)).toBeNull()
  })

  it('sorts by urgency, oldest activity, highest value, then stable ID', () => {
    const records = [
      candidate({ id: 'inactive', lastActivityAt: ago(25) }),
      candidate({ id: 'lead', stage: 'new-lead' }),
      candidate({ id: 'neg-newer', stage: 'negotiation', lastActivityAt: ago(14) }),
      candidate({ id: 'neg-b', stage: 'negotiation', lastActivityAt: ago(20), valuePaise: 500 }),
      candidate({ id: 'neg-c', stage: 'negotiation', lastActivityAt: ago(20), valuePaise: 100 }),
      candidate({ id: 'neg-a', stage: 'negotiation', lastActivityAt: ago(20), valuePaise: 500 }),
      candidate({ id: 'fresh' }),
    ]
    expect(records.map((record) => ({ deal: record, attention: attentionFor(record, NOW) })).sort(compareAttention).map((row) => row.deal.id))
      .toEqual(['neg-a', 'neg-b', 'neg-c', 'neg-newer', 'lead', 'inactive', 'fresh'])
  })
})
