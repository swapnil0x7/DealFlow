import { STAGES } from '../domain/deal'
import type { Deal, Owner } from '../domain/deal'

export type Clock = () => number
export type Random = () => number
export const STAGE_POPULATIONS = [12_000, 10_000, 8_000, 8_000, 7_000, 3_000, 2_000] as const
const DAY = 86_400_000

export function seededRandom(seed: number): Random {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296
  }
}

const OWNER_NAMES = [
  'Aarav Shah', 'Diya Rao', 'Kabir Mehta', 'Ananya Das', 'Arjun Nair',
  'Isha Kapoor', 'Rohan Patel', 'Meera Iyer', 'Vivaan Sen', 'Tara Singh',
  'Aditya Bose', 'Sana Khan', 'Dev Malhotra', 'Nisha Verma', 'Reyansh Jain',
  'Priya Menon', 'Kunal Gupta', 'Avni Sethi', 'Neel Joshi', 'Riya Kulkarni',
]
const COMPANIES = ['Atlas', 'Cedar', 'Orbit', 'Meridian', 'Northstar', 'Juniper', 'Prism', 'Summit']
const INDUSTRIES = ['Systems', 'Foods', 'Logistics', 'Health', 'Energy', 'Retail', 'Labs', 'Finance']

export function seedDeals(options: { seed?: number; clock?: Clock } = {}): { deals: Deal[]; owners: Owner[] } {
  const random = seededRandom(options.seed ?? 42)
  const now = (options.clock ?? Date.now)()
  const owners = OWNER_NAMES.map((name, index) => ({ id: `owner-${index + 1}`, name }))
  const deals: Deal[] = []
  for (const [stageIndex, stage] of STAGES.entries()) {
    for (let index = 0; index < STAGE_POPULATIONS[stageIndex]; index++) {
      const number = deals.length + 1
      const age = 1 + Math.floor(random() * 180)
      const created = now - age * DAY
      const activity = random() < 0.2 ? null : now - Math.floor(random() * age) * DAY
      deals.push({
        id: `deal-${String(number).padStart(5, '0')}`,
        companyName: `${COMPANIES[number % COMPANIES.length]} ${INDUSTRIES[Math.floor(random() * INDUSTRIES.length)]} ${number}`,
        valuePaise: (50_000 + Math.floor(random() * 9_950_001)) * 100,
        ownerId: owners[(number - 1) % owners.length].id,
        stage, createdAt: new Date(created).toISOString(),
        lastActivityAt: activity === null ? null : new Date(activity).toISOString(),
        updatedAt: new Date(activity ?? created).toISOString(), version: 1,
      })
    }
  }
  return { deals, owners }
}
