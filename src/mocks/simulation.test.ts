import { afterEach, describe, expect, it, vi } from 'vitest'
import { clock, command, data } from '../test/fixtures'
import { abortableWait, DEFAULT_SETTINGS, Simulation } from './simulation'

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('adjustable simulator', () => {
  it('notifies only after effective commits, including lost responses, and announces delivery settings/reset', async () => {
    const onNotification = vi.fn()
    const runtime = new Simulation({
      clock,
      createData: data,
      wait: async () => {},
      onNotification,
    })
    runtime.configure({ minSaveDelayMs: 0, maxSaveDelayMs: 0, failureRate: 0 })
    const sessionId = runtime.configuration().sessionId
    const first = command({ sessionId })
    await runtime.move(first)
    expect(onNotification.mock.calls.map(([notice]) => notice)).toEqual([
      { kind: 'changes', sessionId, cursor: 1 },
    ])
    await runtime.move(first)
    await runtime.move(command({ sessionId, mutationId: 'noop', expectedVersion: 2 }))
    await runtime.move(command({ sessionId, mutationId: 'conflict', stage: 'won' }))
    runtime.forceFault('save-failure')
    await runtime.move(
      command({ sessionId, mutationId: 'failed', stage: 'won', expectedVersion: 2 }),
    )
    expect(onNotification).toHaveBeenCalledTimes(1)
    runtime.forceFault('lost-response')
    await expect(
      runtime.move(
        command({ sessionId, mutationId: 'lost-response', stage: 'won', expectedVersion: 2 }),
      ),
    ).rejects.toMatchObject({ issue: { code: 'response_lost' } })
    expect(onNotification).toHaveBeenLastCalledWith({ kind: 'changes', sessionId, cursor: 2 })
    runtime.configure({ changeDeliveryPaused: true })
    expect(onNotification).toHaveBeenLastCalledWith({ kind: 'configuration', sessionId })
    expect(() => runtime.configure({ offline: 'invalid' })).toThrow()
    runtime.configure({ offline: true })
    expect(onNotification).toHaveBeenLastCalledWith({ kind: 'configuration', sessionId })
    const replacement = runtime.reset(17)
    expect(replacement.sessionId).not.toBe(sessionId)
    expect(onNotification).toHaveBeenLastCalledWith({
      kind: 'reset',
      sessionId: replacement.sessionId,
    })
    runtime.dispose()
  })

  it('keeps durable writes successful even when a notification observer throws', async () => {
    const runtime = new Simulation({
      clock,
      createData: data,
      wait: async () => {},
      onNotification: () => {
        throw new Error('Observer failure')
      },
    })
    runtime.configure({ minSaveDelayMs: 0, maxSaveDelayMs: 0, failureRate: 0 })
    const sessionId = runtime.configuration().sessionId
    const result = await runtime.move(command({ sessionId }))
    expect(result.status).toBe('succeeded')
    expect(await runtime.operation('mutation-1', sessionId)).toMatchObject({
      status: 'completed',
      result: { status: 'succeeded' },
    })
    expect((await runtime.snapshot()).cursor).toBe(1)
    runtime.dispose()
  })

  it('starts with documented defaults and independently applies seeded faults to each item', async () => {
    const rolls = [0.01, 0.5, 0.9, 0.5]
    const runtime = new Simulation({
      clock,
      createData: data,
      wait: async () => {},
      random: () => rolls.shift() ?? 0.5,
    })
    expect(runtime.configuration()).toMatchObject(DEFAULT_SETTINGS)
    const sessionId = runtime.configuration().sessionId
    const result = await runtime.bulk([
      command({ sessionId }),
      command({ sessionId, dealId: 'deal-2', mutationId: 'second' }),
    ])
    expect(result.results.map((item) => item.result.status)).toEqual(['failed', 'succeeded'])
    runtime.dispose()
  })

  it.each([
    { minSaveDelayMs: -1 },
    { maxSaveDelayMs: 30_001 },
    { minSaveDelayMs: 2_000, maxSaveDelayMs: 1_000 },
    { failureRate: 1.01 },
    { failureRate: NaN },
    { offline: 'yes' },
    { unexpected: true },
    { teammateIntervalMs: 499 },
    { teammateIntervalMs: 30_001 },
    { teammatesEnabled: 'yes' },
    { changeDeliveryPaused: 1 },
  ])('rejects invalid settings atomically: %j', (settings) => {
    const runtime = new Simulation({ clock, createData: data })
    expect(() => runtime.configure(settings)).toThrow()
    expect(runtime.configuration()).toMatchObject(DEFAULT_SETTINGS)
    runtime.dispose()
  })

  it('repeats delay/failure behavior after reset with the same seed', async () => {
    const delays: number[] = []
    const runtime = new Simulation({
      clock,
      createData: data,
      wait: async (delay) => {
        delays.push(delay)
      },
    })
    const results = []
    for (let run = 0; run < 2; run++) {
      runtime.reset(17)
      const sessionId = runtime.configuration().sessionId
      results.push(
        (
          await runtime.bulk([
            command({ sessionId }),
            command({ sessionId, dealId: 'deal-2', mutationId: 'second' }),
          ])
        ).results.map((item) => item.result.status),
      )
    }
    expect(results[0]).toEqual(results[1])
    expect(delays.slice(0, 2)).toEqual(delays.slice(2))
    runtime.dispose()
  })
})

describe('teammate ownership and simulation lifecycle', () => {
  it('schedules one guarded writer, uses another actor, preserves activity, and leaves user faults untouched', async () => {
    vi.useFakeTimers()
    const runtime = new Simulation({
      clock,
      createData: data,
      wait: async () => {},
      random: () => 0,
    })
    runtime.configure({
      teammatesEnabled: true,
      teammateIntervalMs: 500,
      minSaveDelayMs: 0,
      maxSaveDelayMs: 0,
      failureRate: 0,
    })
    runtime.configure({ teammatesEnabled: true })
    expect(vi.getTimerCount()).toBe(1)
    runtime.forceFault('save-failure')
    await vi.advanceTimersByTimeAsync(500)
    const snapshot = await runtime.snapshot()
    expect(snapshot.cursor).toBe(1)
    expect(snapshot.deals[0]).toMatchObject({
      version: 2,
      stage: 'contacted',
      lastActivityAt: null,
    })
    expect((await runtime.changes(0, snapshot.sessionId)).changes[0].actorId).toBe('owner-2')
    expect(
      await runtime.move(
        command({ sessionId: snapshot.sessionId, expectedVersion: 2, stage: 'won' }),
      ),
    ).toMatchObject({ status: 'failed' })
    runtime.configure({ teammatesEnabled: false })
    expect(vi.getTimerCount()).toBe(0)
    runtime.dispose()
  })

  it('cancels an in-flight teammate attempt on stop, offline, and reset instead of leaking writes/timers', async () => {
    vi.useFakeTimers()
    const runtime = new Simulation({
      clock,
      createData: data,
      random: () => 0,
      wait: (ms, signal) => (ms === 20 ? Promise.resolve() : abortableWait(ms, signal)),
    })
    runtime.configure({
      teammatesEnabled: true,
      teammateIntervalMs: 500,
      minSaveDelayMs: 1_000,
      maxSaveDelayMs: 1_000,
      failureRate: 0,
    })
    await vi.advanceTimersByTimeAsync(500)
    runtime.configure({ teammatesEnabled: false })
    await vi.advanceTimersByTimeAsync(2_000)
    expect((await runtime.snapshot()).cursor).toBe(0)
    runtime.configure({ teammatesEnabled: true })
    await vi.advanceTimersByTimeAsync(500)
    runtime.configure({ offline: true })
    await vi.advanceTimersByTimeAsync(2_000)
    expect(vi.getTimerCount()).toBe(0)
    runtime.reset(42)
    await vi.advanceTimersByTimeAsync(2_000)
    expect((await runtime.snapshot()).cursor).toBe(0)
    expect(runtime.configuration()).toMatchObject({ teammatesEnabled: false, offline: false })
    runtime.dispose()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('pauses feed delivery without advancing the held cursor and releases the same event after resume', async () => {
    const runtime = new Simulation({ clock, createData: data, wait: async () => {} })
    const { sessionId } = runtime.configuration()
    expect(await runtime.conflict('deal-1')).toMatchObject({ status: 'succeeded' })
    runtime.configure({ changeDeliveryPaused: true })
    expect(await runtime.changes(0, sessionId)).toMatchObject({
      changes: [],
      nextCursor: 0,
      deliveryPaused: true,
    })
    runtime.configure({ changeDeliveryPaused: false })
    expect(await runtime.changes(0, sessionId)).toMatchObject({
      changes: [{ sequence: 1, actorId: 'owner-2' }],
      nextCursor: 1,
    })
    runtime.dispose()
  })

  it('creates a repeatable conflict through guarded commits and rejects it while offline', async () => {
    const runtime = new Simulation({ clock, createData: data, wait: async () => {} })
    const { sessionId } = runtime.configuration()
    await runtime.conflict('deal-1')
    expect(await runtime.move(command({ sessionId }))).toMatchObject({
      status: 'conflicted',
      latest: { version: 2 },
    })
    runtime.configure({ offline: true })
    await expect(runtime.conflict('deal-1')).rejects.toMatchObject({ issue: { code: 'offline' } })
    runtime.dispose()
  })
})
