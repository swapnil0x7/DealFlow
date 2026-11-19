export type Work<Result> = Generator<void, Result, void>

export function assertNotAborted(signal?: AbortSignal): void {
  signal?.throwIfAborted()
}

/** Same algorithm for small synchronous service calls and cooperative UI preparation. */
export function complete<Result>(work: Work<Result>): Result {
  let step = work.next()
  while (!step.done) step = work.next()
  return step.value
}

async function yieldToBrowser(): Promise<void> {
  const scheduler = (
    globalThis as typeof globalThis & {
      scheduler?: { yield: () => Promise<void> }
    }
  ).scheduler
  if (scheduler) await scheduler.yield()
  else await new Promise<void>((resolve) => setTimeout(resolve, 0))
}

/** Bounded slices include subscriber work; no promise per record and no microtask-only yielding. */
export async function cooperate<Result>(
  work: Work<Result>,
  signal?: AbortSignal,
  batch: <T>(action: () => T) => T = (action) => action(),
): Promise<Result> {
  try {
    while (true) {
      assertNotAborted(signal)
      const result = batch(() => {
        const deadline = performance.now() + 4
        for (let count = 0; count < 256; count++) {
          assertNotAborted(signal)
          const step = work.next()
          if (step.done) return step
          if (performance.now() >= deadline) break
        }
        return null
      })
      if (result?.done) return result.value
      await yieldToBrowser()
    }
  } finally {
    work.return(undefined as never)
  }
}
