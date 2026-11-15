import { expect, test } from '@playwright/test'
import type { ChangePage, Snapshot } from '../src/api/contracts'

test('built demo initializes its worker and serves full-volume guarded API requests', async ({ page }) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Sales pipeline', exact: true })).toBeVisible()
  await expect(page.getByLabel('Pipeline summary')).toContainText('50,000')
  const outcome = await page.evaluate(async () => {
    const snapshot = await (await fetch('/api/deals')).json() as Snapshot
    await fetch('/api/simulation', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minSaveDelayMs: 0, maxSaveDelayMs: 0, failureRate: 0 }),
    })
    const headers = { 'Content-Type': 'application/json', 'X-DealDesk-Session': snapshot.sessionId }
    const command = { stage: 'contacted', expectedVersion: 1, mutationId: 'browser-move', actorId: 'owner-1' }
    const saved = await (await fetch(`/api/deals/${snapshot.deals[0].id}`, {
      method: 'PATCH', headers, body: JSON.stringify(command),
    })).json()
    const repeated = await (await fetch(`/api/deals/${snapshot.deals[0].id}`, {
      method: 'PATCH', headers, body: JSON.stringify(command),
    })).json()
    const changes = await (await fetch('/api/changes?after=0', { headers })).json() as ChangePage
    return { count: snapshot.deals.length, owners: snapshot.owners.length, saved, repeated, changes }
  })
  expect(outcome).toMatchObject({ count: 50_000, owners: 20, saved: { status: 'succeeded', receipt: { record: { version: 2 } } } })
  expect(outcome.saved).toEqual(outcome.repeated)
  expect(outcome.changes.changes).toHaveLength(1)
  expect(errors).toEqual([])
})

test('initial load failures offer a working keyboard-accessible retry', async ({ page }) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window)
    let fail = true
    // Fault only the app load, after the worker is initialized. Further requests use the real MSW handler.
    window.fetch = (input, init) => {
      if (fail && String(input).endsWith('/api/deals')) {
        fail = false
        return Promise.resolve(new Response(JSON.stringify({ error: { code: 'read_failed', message: 'Forced initial load failure', retryable: true } }), {
          status: 503, headers: { 'Content-Type': 'application/json' },
        }))
      }
      return originalFetch(input, init)
    }
  })
  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText('We couldn’t load your pipeline')
  await page.getByRole('button', { name: 'Retry loading' }).focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('heading', { name: 'Sales pipeline', exact: true })).toBeVisible()
})

test('worker startup failure shows recovery instructions instead of an empty pipeline', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.serviceWorker, 'register', {
      value: () => Promise.reject(new Error('Forced worker initialization failure')),
    })
  })
  await page.goto('/')
  await expect(page.getByRole('alert')).toContainText('DealDesk couldn’t start')
  await expect(page.getByRole('button', { name: 'Reload workspace' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Sales pipeline', exact: true })).toHaveCount(0)
})

test('offline simulation blocks data requests while local controls can reconnect', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('heading', { name: 'Sales pipeline', exact: true })).toBeVisible()
  const recovered = await page.evaluate(async () => {
    const configure = (offline: boolean) => fetch('/api/simulation', {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ offline }),
    })
    await configure(true)
    let interrupted = false
    try { await fetch('/api/deals') } catch { interrupted = true }
    await configure(false)
    const snapshot = await (await fetch('/api/deals')).json() as Snapshot
    return { interrupted, count: snapshot.deals.length }
  })
  expect(recovered).toEqual({ interrupted: true, count: 50_000 })
})
