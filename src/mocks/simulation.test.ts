import { describe, expect, it } from 'vitest'
import { clock, command, data } from '../test/fixtures'
import { DEFAULT_SETTINGS, Simulation } from './simulation'

describe('adjustable simulator', () => {
  it('starts with documented defaults and independently applies seeded faults to each item', async () => {
    const rolls = [0.01, 0.5, 0.9, 0.5]
    const runtime = new Simulation({ clock, createData: data, wait: async () => {}, random: () => rolls.shift() ?? 0.5 })
    expect(runtime.configuration()).toMatchObject(DEFAULT_SETTINGS)
    const sessionId = runtime.configuration().sessionId
    const result = await runtime.bulk([
      command({ sessionId }), command({ sessionId, dealId: 'deal-2', mutationId: 'second' }),
    ])
    expect(result.results.map((item) => item.result.status)).toEqual(['failed', 'succeeded'])
    runtime.dispose()
  })

  it.each([
    { minSaveDelayMs: -1 }, { maxSaveDelayMs: 30_001 }, { minSaveDelayMs: 2_000, maxSaveDelayMs: 1_000 },
    { failureRate: 1.01 }, { failureRate: NaN }, { offline: 'yes' }, { unexpected: true },
  ])('rejects invalid settings atomically: %j', (settings) => {
    const runtime = new Simulation({ clock, createData: data })
    expect(() => runtime.configure(settings)).toThrow()
    expect(runtime.configuration()).toMatchObject(DEFAULT_SETTINGS)
    runtime.dispose()
  })

  it('repeats delay/failure behavior after reset with the same seed', async () => {
    const delays: number[] = []
    const runtime = new Simulation({ clock, createData: data, wait: async (delay) => { delays.push(delay) } })
    const results = []
    for (let run = 0; run < 2; run++) {
      runtime.reset(17)
      const sessionId = runtime.configuration().sessionId
      results.push((await runtime.bulk([
        command({ sessionId }), command({ sessionId, dealId: 'deal-2', mutationId: 'second' }),
      ])).results.map((item) => item.result.status))
    }
    expect(results[0]).toEqual(results[1])
    expect(delays.slice(0, 2)).toEqual(delays.slice(2))
    runtime.dispose()
  })
})
