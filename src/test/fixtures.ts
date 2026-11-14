import type { MoveCommand } from '../api/contracts'
import type { Deal } from '../domain/deal'

export const NOW = Date.parse('2026-11-14T12:00:00Z')
export const clock = () => NOW
export const owners = [{ id: 'owner-1', name: 'Aarav' }, { id: 'owner-2', name: 'Diya' }]
export const deal: Deal = {
  id: 'deal-1', companyName: 'Atlas Systems', valuePaise: 100_000_00,
  ownerId: 'owner-1', stage: 'new-lead', version: 1,
  createdAt: '2026-10-01T00:00:00.000Z', lastActivityAt: null, updatedAt: '2026-10-01T00:00:00.000Z',
}
export const data = () => ({ deals: [{ ...deal }, { ...deal, id: 'deal-2' }], owners })
export const command = (overrides: Partial<MoveCommand> = {}): MoveCommand => ({
  sessionId: 'session-1', dealId: 'deal-1', stage: 'contacted', expectedVersion: 1,
  mutationId: 'mutation-1', actorId: 'owner-1', ...overrides,
})

export function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((done) => { resolve = done })
  return { promise, resolve }
}
