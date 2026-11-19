import type { Deal } from './deal'

export interface DayWindow {
  readonly start: number
  readonly end: number
}

/** Browser-local calendar boundaries, including 23/25-hour daylight-saving days. */
export function localDayWindow(now: number): DayWindow {
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const end = new Date(start)
  end.setDate(end.getDate() + 1)
  // Some zones skip midnight itself; normalize the following day independently.
  end.setHours(0, 0, 0, 0)
  return { start: start.getTime(), end: end.getTime() }
}

export function updatedOnDay(deal: Deal, day: DayWindow): boolean {
  const updated = Date.parse(deal.updatedAt)
  return updated >= day.start && updated < day.end
}
