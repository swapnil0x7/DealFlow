import type { Deal } from './deal'

const DAY_MS = 86_400_000

export interface Attention {
  readonly urgency: 1 | 2 | 3
  readonly reason: string
  readonly baseline: number
}

/** Whole elapsed days, rather than local calendar boundaries, keep thresholds timezone-independent. */
export function attentionFor(deal: Deal, now: number): Attention | null {
  if (deal.stage === 'won' || deal.stage === 'lost') return null
  const created = Date.parse(deal.createdAt)
  const baseline = Date.parse(deal.lastActivityAt ?? deal.createdAt)
  const inactiveDays = Math.max(0, Math.floor((now - baseline) / DAY_MS))
  const leadDays = Math.max(0, Math.floor((now - created) / DAY_MS))
  if (deal.stage === 'negotiation' && inactiveDays >= 14) {
    return {
      urgency: 3,
      reason: `Negotiation inactive for ${inactiveDays} days`,
      baseline,
    }
  }
  if (deal.stage === 'new-lead' && leadDays >= 2) {
    return {
      urgency: 2,
      reason: `New lead waiting ${leadDays} days`,
      baseline,
    }
  }
  if (inactiveDays >= 7) {
    return {
      urgency: 1,
      reason: `No activity for ${inactiveDays} days`,
      baseline,
    }
  }
  return null
}

/** Ascending comparator: highest urgency first, then oldest activity, highest value, stable ID. */
export function compareAttention(
  a: { deal: Deal; attention: Attention | null },
  b: { deal: Deal; attention: Attention | null },
): number {
  return (
    (b.attention?.urgency ?? 0) - (a.attention?.urgency ?? 0) ||
    (a.attention?.baseline ?? Infinity) - (b.attention?.baseline ?? Infinity) ||
    b.deal.valuePaise - a.deal.valuePaise ||
    a.deal.id.localeCompare(b.deal.id)
  )
}
