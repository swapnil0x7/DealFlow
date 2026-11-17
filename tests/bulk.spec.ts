import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { MoveCommand, Snapshot } from '../src/api/contracts'
import type { Stage } from '../src/domain/deal'
import { chooseStage } from './helpers/stage'
import { selectDropdown } from './helpers/dropdown'
import { openChanges, closeChanges, changesPanel } from './helpers/changes'

const diagnostics = new WeakMap<Page, string[]>()
test.beforeEach(({ page }) => {
  const messages: string[] = []
  diagnostics.set(page, messages)
  page.on('console', (message) => {
    if (['warning', 'error'].includes(message.type()) && message.text().includes('AG Grid'))
      messages.push(message.text())
  })
})
test.afterEach(({ page }) => {
  expect(diagnostics.get(page)).toEqual([])
})

async function control(page: Page, path: string, body: object, method = 'POST') {
  await page.evaluate(
    async ({ path, body, method }) => {
      const response = await fetch(`/api/simulation${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error('Simulation control failed')
    },
    { path, body, method },
  )
}
async function snapshot(page: Page): Promise<Snapshot> {
  return page.evaluate(async () => (await fetch('/api/deals')).json())
}
async function remote(
  page: Page,
  sessionId: string,
  dealId: string,
  expectedVersion: number,
  stage: Stage,
) {
  await page.evaluate(
    async (command) => {
      const response = await fetch(`/api/deals/${command.dealId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-DealDesk-Session': command.sessionId },
        body: JSON.stringify(command),
      })
      if ((await response.json()).status !== 'succeeded')
        throw new Error('Remote edit did not succeed')
    },
    {
      sessionId,
      actorId: 'owner-2',
      dealId,
      expectedVersion,
      stage,
      mutationId: `teammate-${crypto.randomUUID()}`,
    },
  )
}
function capture(page: Page) {
  const batches: MoveCommand[][] = []
  const active = new Set<object>()
  let peak = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/deals/bulk-move') {
      batches.push((request.postDataJSON() as { commands: MoveCommand[] }).commands)
      active.add(request)
      peak = Math.max(peak, active.size)
    }
  })
  page.on('requestfinished', (request) => active.delete(request))
  page.on('requestfailed', (request) => active.delete(request))
  return { batches, peak: () => peak }
}

/** Keep the authoritative 50k MSW repository, expose a small deterministic client fixture when requested. */
async function fixture(page: Page, indexes: number[]) {
  await page.addInitScript((indexes) => {
    const original = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const response = await original(input, init)
      const path = new URL(input instanceof Request ? input.url : String(input), location.href)
        .pathname
      if (path === '/api/deals' && (init?.method ?? 'GET') === 'GET' && response.ok) {
        const body = await response.json()
        return new Response(
          JSON.stringify({ ...body, deals: indexes.map((index) => body.deals[index]) }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return response
    }
  }, indexes)
}
async function open(page: Page, delay = 0, deliveryPaused = true) {
  await page.goto('/')
  await expect(page.getByRole('grid', { name: 'Sales pipeline deals' })).toBeVisible()
  await control(
    page,
    '',
    {
      minSaveDelayMs: delay,
      maxSaveDelayMs: delay,
      failureRate: 0,
      changeDeliveryPaused: deliveryPaused,
    },
    'PATCH',
  )
  return snapshot(page)
}
const operations = (page: Page) => page.getByTestId('bulk-operation')
const count = (operation: Locator, state: string) =>
  operation.getByTestId('bulk-counts').locator(`[data-state="${state}"] strong`)
async function confirm(page: Page) {
  await page.getByRole('button', { name: 'Review bulk move', exact: true }).click()
  await page.getByRole('button', { name: 'Confirm bulk move', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await openChanges(page)
}
test('mixed results keep exact counts; keyboard Retry, conflict review, and partial bulk Undo retain earlier outcomes', async ({
  page,
}, testInfo) => {
  await fixture(page, [0, 1, 2, 3, 12_000])
  const { batches } = capture(page)
  const initial = await open(page)
  await page.getByRole('button', { name: 'Select all matching', exact: true }).click()
  await expect(page.getByTestId('selection-count')).toContainText('5 selected')
  const reviewTrigger = page.getByRole('button', { name: 'Review bulk move', exact: true })
  await reviewTrigger.focus()
  await page.keyboard.press('Enter')
  const review = page.getByRole('dialog', { name: 'Review bulk stage change' })
  await expect(
    review.getByText('Already in target stage', { exact: true }).locator('+ dd'),
  ).toContainText('1 —')
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.keyboard.press('Escape')
  await expect(reviewTrigger).toBeFocused()
  expect(batches).toHaveLength(0)
  await remote(page, initial.sessionId, initial.deals[3].id, 1, 'won')
  await control(page, '/faults', { fault: 'save-failure' })
  await confirm(page)
  const original = operations(page).filter({
    has: page.getByRole('heading', { name: 'Bulk move · 5 deals · Contacted', exact: true }),
  })
  await expect(count(original, 'succeeded')).toHaveText('2')
  await expect(count(original, 'failed')).toHaveText('1')
  await expect(count(original, 'conflicted')).toHaveText('1')
  await expect(count(original, 'skipped')).toHaveText('1')
  expect(batches[0]).toHaveLength(4)
  await selectDropdown(original.getByRole('combobox'), /^Failed \(/)
  await expect(original.getByTestId('bulk-item')).toHaveCount(1)
  await original.getByRole('button', { name: 'Retry eligible failed items' }).focus()
  await page.keyboard.press('Enter')
  await expect(count(original, 'succeeded')).toHaveText('3')
  expect(batches[1]).toEqual([batches[0][0]])
  await expect(original).toBeFocused()
  await selectDropdown(original.getByRole('combobox'), /^Conflict \(/)
  const conflictTrigger = original.getByRole('button', { name: 'Review bulk conflict' })
  await conflictTrigger.focus()
  await page.keyboard.press('Enter')
  const conflict = changesPanel(page)
  await expect(conflict).toContainText('Won (version 2)')
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: /^Changes/ })).toBeFocused()
  await openChanges(page)
  await selectDropdown(original.getByRole('combobox'), /^Conflict \(/)
  await conflictTrigger.click()
  await conflict.getByRole('button', { name: 'Move to Contacted', exact: true }).click()
  await openChanges(page)
  await expect(operations(page)).toHaveCount(2)
  await expect(count(operations(page).first(), 'succeeded')).toHaveText('1')
  expect(batches[2][0]).toMatchObject({
    dealId: initial.deals[3].id,
    expectedVersion: 2,
    stage: 'contacted',
  })
  await expect(count(original, 'conflicted')).toHaveText('1')

  // One unseen teammate change, one failed reversal, and one successful reversal.
  await remote(page, initial.sessionId, initial.deals[1].id, 2, 'won')
  await original.getByRole('button', { name: 'Review Undo for 3 successes' }).click()
  const undoReview = page.getByRole('dialog', { name: 'Review bulk Undo' })
  await expect(undoReview).toContainText('Each deal’s previous stage')
  await page.keyboard.press('Escape')
  await expect(original.getByRole('button', { name: 'Review Undo for 3 successes' })).toBeFocused()
  expect(batches).toHaveLength(3)
  await original.getByRole('button', { name: 'Review Undo for 3 successes' }).click()
  await control(page, '/faults', { fault: 'save-failure' })
  await undoReview.getByRole('button', { name: 'Confirm bulk Undo' }).click()
  const undo = operations(page).first()
  await expect(count(undo, 'succeeded')).toHaveText('1')
  await expect(count(undo, 'failed')).toHaveText('1')
  await expect(count(undo, 'conflicted')).toHaveText('1')
  expect(
    batches[3].every((command) => command.expectedVersion === 2 && command.stage === 'new-lead'),
  ).toBe(true)
  await undo.getByRole('button', { name: 'Retry eligible failed items' }).click()
  await expect(count(undo, 'succeeded')).toHaveText('2')
  expect(batches[4]).toEqual([batches[3][0]])
  await expect(count(original, 'succeeded')).toHaveText('3')
  await selectDropdown(undo.getByRole('combobox'), /^Conflict \(/)
  await expect(undo.getByTestId('bulk-item')).toHaveCount(1)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('mixed-bulk-undo.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  )
})

test('12,000 selected off-screen deals retain fixed commands through sort/filter changes and teammate activity', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(90_000)
  // Loopback throughput is independent of host-network notifications. The offline UI flow is tested separately.
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => true })
  })
  const { batches, peak } = capture(page)
  const start = performance.now()
  const initial = await open(page, 350, false)
  const loadMs = performance.now() - start
  await selectDropdown(page.getByRole('combobox', { name: 'Stage', exact: true }), 'New Lead')
  await expect(page.getByTestId('matching-count')).toContainText('12,000')
  await page.evaluate(() => {
    const state = window as unknown as {
      bulkLongTasks: number[]
      bulkObserver?: PerformanceObserver
    }
    state.bulkLongTasks = []
    state.bulkObserver = new PerformanceObserver((list) =>
      state.bulkLongTasks.push(...list.getEntries().map((entry) => entry.duration)),
    )
    state.bulkObserver.observe({ type: 'longtask', buffered: false })
  })
  const selectedAt = performance.now()
  await page
    .getByRole('button', { name: /^(Refresh list and select|Select) all matching$/ })
    .click()
  await expect(page.getByTestId('selection-count')).toContainText('12,000 selected')
  const selectionMs = performance.now() - selectedAt
  await page.getByRole('columnheader', { name: 'Value', exact: true }).click()
  await expect(page.getByTestId('selection-count')).toContainText('12,000 selected')
  const firstCell = page.locator('.ag-row[row-index="0"] [col-id="company"]').first()
  await firstCell.click()
  await page.keyboard.press('End')
  await expect(page.locator('.ag-row[row-index="11999"] [col-id="status"]')).toBeFocused()
  const mounted = await page.locator('.ag-row').count()
  expect(mounted).toBeLessThan(100)
  await control(
    page,
    '',
    { teammatesEnabled: true, teammateIntervalMs: 500, failureRate: 0.1 },
    'PATCH',
  )
  const bulkStart = performance.now()
  await confirm(page)
  await expect.poll(() => batches.length).toBeGreaterThanOrEqual(4)
  const typingAt = performance.now()
  await page.getByRole('searchbox').fill('Cedar')
  await expect(page.getByRole('searchbox')).toHaveValue('Cedar')
  const inputMs = performance.now() - typingAt
  await expect(page.getByTestId('selection-count')).toContainText('0 selected')
  const operation = operations(page).first()
  await expect(count(operation, 'queued')).toHaveText('0', { timeout: 60_000 })
  await expect(count(operation, 'saving')).toHaveText('0', { timeout: 60_000 })
  const bulkMs = performance.now() - bulkStart
  const saved = Number((await count(operation, 'succeeded').innerText()).replaceAll(',', ''))
  const conflicts = Number((await count(operation, 'conflicted').innerText()).replaceAll(',', ''))
  const failed = Number((await count(operation, 'failed').innerText()).replaceAll(',', ''))
  expect(saved + conflicts + failed).toBe(12_000)
  expect(failed).toBeGreaterThan(0)
  expect(batches).toHaveLength(60)
  expect(peak()).toBeLessThanOrEqual(4)
  expect(batches.every((commands) => commands.length <= 200)).toBe(true)
  const expected = initial.deals
    .filter((record) => record.stage === 'new-lead')
    .map((record) => record.id)
    .sort()
  const commands = batches.flat()
  expect(commands.map((command) => command.dealId).sort()).toEqual(expected)
  expect(new Set(commands.map((command) => command.mutationId)).size).toBe(12_000)
  expect(
    commands.every((command) => command.expectedVersion === 1 && command.stage === 'contacted'),
  ).toBe(true)
  const tasks = await page.evaluate(() => {
    const state = window as unknown as {
      bulkLongTasks: number[]
      bulkObserver: PerformanceObserver
    }
    state.bulkObserver.disconnect()
    return {
      count: state.bulkLongTasks.length,
      totalMs: state.bulkLongTasks.reduce((a, b) => a + b, 0),
      maxMs: Math.max(0, ...state.bulkLongTasks),
    }
  })
  const metrics = {
    dataset: 50_000,
    selected: 12_000,
    batchSize: 200,
    maxInFlight: peak(),
    saved,
    conflicts,
    failed,
    mounted,
    loadMs,
    selectionMs,
    inputMs,
    bulkMs,
    longTasks: tasks,
    browser: browser.version(),
    viewport: page.viewportSize(),
    production: process.env.PLAYWRIGHT_DEV !== '1',
    workers: testInfo.config.workers,
    simulationDelayMs: 350,
    teammatesEveryMs: 500,
  }
  await testInfo.attach('stage5-bulk-performance', {
    body: JSON.stringify(metrics, null, 2),
    contentType: 'application/json',
  })
})

test('offline interruption keeps queued and unconfirmed items; reconnect alone never launches mass writes', async ({
  page,
}) => {
  test.setTimeout(60_000)
  await fixture(
    page,
    Array.from({ length: 1_001 }, (_, index) => index),
  )
  // Hold transport delivery until offline mode is applied; the scenario must not depend on UI speed.
  await page.addInitScript(() => {
    const original = window.fetch.bind(window)
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const state = {
      calls: 0,
      holding: true,
      release: () => {
        state.holding = false
        release()
      },
    }
    Object.assign(window, { bulkInterruption: state })
    window.fetch = async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input), location.href)
        .pathname
      if (init?.method === 'POST' && path === '/api/deals/bulk-move' && state.holding) {
        state.calls++
        await gate
      }
      return original(input, init)
    }
  })
  const { batches } = capture(page)
  await open(page, 1_200)
  await page.getByRole('button', { name: 'Select all matching', exact: true }).click()
  await confirm(page)
  const operation = operations(page).first()
  await expect
    .poll(() =>
      page.evaluate(
        () => (window as unknown as { bulkInterruption: { calls: number } }).bulkInterruption.calls,
      ),
    )
    .toBe(4)
  const simulation = page.getByRole('dialog', { name: 'Simulation controls' })
  await closeChanges(page)
  await page.getByRole('button', { name: 'Simulation', exact: true }).click()
  await simulation.getByRole('checkbox', { name: 'Offline simulation' }).check()
  await simulation.getByRole('button', { name: 'Apply settings' }).click()
  await expect(page.getByTestId('connection-status')).toHaveText('Offline')
  await page.evaluate(() =>
    (window as unknown as { bulkInterruption: { release: () => void } }).bulkInterruption.release(),
  )
  await simulation.getByRole('button', { name: 'Close simulation' }).click()
  await openChanges(page)
  await expect(count(operation, 'unconfirmed')).toHaveText('800')
  await expect(count(operation, 'queued')).toHaveText('201')
  await closeChanges(page)
  await page.getByRole('button', { name: 'Simulation', exact: true }).click()
  await simulation.getByRole('checkbox', { name: 'Offline simulation' }).uncheck()
  await simulation.getByRole('button', { name: 'Apply settings' }).click()
  await simulation.getByRole('button', { name: 'Close simulation' }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await openChanges(page)
  await expect(page.getByTestId('connection-status')).toHaveText('Live updates paused')
  await expect(operation.getByRole('button', { name: 'Resume queued work' })).toBeEnabled()
  expect(batches).toHaveLength(4)
  await operation.getByRole('button', { name: 'Check unconfirmed items' }).click()
  await expect(
    operation.getByRole('button', { name: 'Check unconfirmed items', exact: true }),
  ).toBeEnabled({ timeout: 20_000 })
  await expect(count(operation, 'unconfirmed')).toHaveText('800')
  expect(batches).toHaveLength(4)
  await operation.getByRole('button', { name: 'Resume queued work' }).focus()
  await page.keyboard.press('Enter')
  await expect(count(operation, 'succeeded')).toHaveText('201', { timeout: 15_000 })
  expect(batches).toHaveLength(6)
  await operation.getByRole('button', { name: 'Retry checked originals' }).click()
  await expect(count(operation, 'succeeded')).toHaveText('1,001', { timeout: 15_000 })
  expect(batches).toHaveLength(10)
  expect(batches.slice(6).flat()).toEqual(batches.slice(0, 4).flat())
  expect(
    (await snapshot(page)).deals.every(
      (record) => record.version === 2 && record.stage === 'contacted',
    ),
  ).toBe(true)
})

test('lost bulk responses with paused delivery reconcile each receipt without repeating commits', async ({
  page,
}) => {
  await fixture(page, [0, 1, 2, 3, 4])
  const { batches } = capture(page)
  await open(page)
  await page.getByRole('button', { name: 'Select all matching', exact: true }).click()
  await control(page, '/faults', { fault: 'lost-response' })
  await confirm(page)
  const operation = operations(page).first()
  await expect(count(operation, 'unconfirmed')).toHaveText('5')
  await control(page, '/faults', { fault: 'read-failure' })
  await operation.getByRole('button', { name: 'Check unconfirmed items' }).click()
  await expect(count(operation, 'succeeded')).toHaveText('4')
  await expect(count(operation, 'unconfirmed')).toHaveText('1')
  await operation.getByRole('button', { name: 'Check unconfirmed items' }).click()
  await expect(count(operation, 'succeeded')).toHaveText('5')
  expect(batches).toHaveLength(1)
  expect((await snapshot(page)).deals.every((record) => record.version === 2)).toBe(true)
})

test('Space selection, sorting, explicit refresh, and cursor resync retain original selected versions', async ({
  page,
}) => {
  await fixture(page, [0, 1, 46_000])
  await page.addInitScript(() => {
    const original = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const response = await original(input, init)
      const state = window as unknown as { expireBulkCursor?: boolean }
      if (
        state.expireBulkCursor &&
        new URL(input instanceof Request ? input.url : String(input), location.href).pathname ===
          '/api/changes' &&
        response.ok
      ) {
        state.expireBulkCursor = false
        const body = await response.json()
        return new Response(
          JSON.stringify({ ...body, changes: [], hasMore: false, resyncRequired: true }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return response
    }
  })
  const { batches } = capture(page)
  const initial = await open(page, 0, false)
  await selectDropdown(page.getByRole('combobox', { name: 'Stage', exact: true }), 'New Lead')
  await expect(page.getByTestId('matching-count')).toContainText('2 matching deals')
  const cell = page.locator(`.ag-row[row-id="${initial.deals[0].id}"] [col-id="company"]`)
  await cell.click()
  await page.keyboard.press('Space')
  await expect(page.getByTestId('selection-count')).toContainText('1 selected')
  await page.getByRole('button', { name: 'Select all matching', exact: true }).click()
  await remote(page, initial.sessionId, initial.deals[0].id, 1, 'won')
  await remote(page, initial.sessionId, initial.deals[2].id, 1, 'new-lead')
  await expect(page.getByTestId('selection-count')).toContainText('2 selected')
  await expect(page.getByTestId('selection-count')).toContainText('1 changed since selection')
  await expect(cell).toContainText('Selection uses an earlier version')
  await page.getByRole('columnheader', { name: 'Value', exact: true }).click()
  await expect(page.getByTestId('selection-count')).toContainText('2 selected')
  await page.getByRole('button', { name: 'Refresh list', exact: true }).click()
  await expect(page.locator(`.ag-row[row-id="${initial.deals[0].id}"]`)).toHaveCount(0)
  await expect(page.locator(`.ag-row[row-id="${initial.deals[2].id}"]`).first()).toHaveAttribute(
    'aria-selected',
    'false',
  )
  await page.evaluate(() => {
    ;(window as unknown as { expireBulkCursor: boolean }).expireBulkCursor = true
    // Foreground catch-up checks the cursor even when there are no new commit notifications.
    window.dispatchEvent(new Event('focus'))
  })
  await expect
    .poll(
      async () =>
        await page.evaluate(
          () => (window as unknown as { expireBulkCursor: boolean }).expireBulkCursor,
        ),
    )
    .toBe(false)
  await page.getByRole('button', { name: 'Review bulk move', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Review bulk stage change' })
  await dialog.getByText('Inspect captured commands', { exact: true }).click()
  await expect(
    dialog.getByRole('listitem').filter({ hasText: initial.deals[0].companyName }),
  ).toContainText('(version 1)')
  await dialog.getByRole('button', { name: 'Confirm bulk move' }).click()
  await openChanges(page)
  await expect(count(operations(page).first(), 'conflicted')).toHaveText('1')
  await expect(count(operations(page).first(), 'succeeded')).toHaveText('1')
  expect(batches[0].map((command) => command.dealId).sort()).toEqual(
    initial.deals
      .slice(0, 2)
      .map((record) => record.id)
      .sort(),
  )
  expect(batches[0].every((command) => command.expectedVersion === 1)).toBe(true)
  await selectDropdown(page.getByRole('combobox', { name: 'Owner', exact: true }), 'Diya Rao')
  await expect(page.getByTestId('selection-count')).toContainText('0 selected')
  await expect(page.getByTestId('selection-count')).toContainText('Selection cleared')
})

test('matching bulk feed events confirm before a held HTTP response and a late error cannot downgrade results', async ({
  page,
}) => {
  await fixture(page, [0, 1])
  await page.addInitScript(() => {
    const original = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const response = await original(input, init)
      if (
        new URL(input instanceof Request ? input.url : String(input), location.href).pathname ===
          '/api/deals/bulk-move' &&
        init?.method === 'POST'
      ) {
        await new Promise<void>((resolve) => {
          ;(window as unknown as { releaseBulkResponse: () => void }).releaseBulkResponse = resolve
        })
        throw new TypeError('Simulated late response interruption')
      }
      return response
    }
  })
  const initial = await open(page, 0, false)
  await page.getByRole('button', { name: 'Select all matching', exact: true }).click()
  await confirm(page)
  const operation = operations(page).first()
  await expect(count(operation, 'succeeded')).toHaveText('2')
  await remote(page, initial.sessionId, initial.deals[0].id, 2, 'won')
  await expect(
    page.locator(`.ag-row[row-id="${initial.deals[0].id}"]`).getByTestId('deal-stage'),
  ).toHaveText('Won')
  await expect(operation.getByRole('button', { name: 'Review Undo for 1 successes' })).toBeVisible()
  await page.evaluate(() =>
    (window as unknown as { releaseBulkResponse: () => void }).releaseBulkResponse(),
  )
  await expect(count(operation, 'unconfirmed')).toHaveText('0')
  await expect(count(operation, 'succeeded')).toHaveText('2')
  expect((await snapshot(page)).deals[0]).toMatchObject({ version: 3, stage: 'won' })
})

test('warned reset disposes active bulk queues and old callbacks cannot reappear in the new session', async ({
  page,
}) => {
  await page.clock.install()
  await fixture(
    page,
    Array.from({ length: 1_001 }, (_, index) => index),
  )
  const initial = await open(page, 3_000)
  const { batches } = capture(page)
  await page.getByRole('button', { name: 'Select all matching', exact: true }).click()
  await confirm(page)
  await expect.poll(() => batches.length).toBe(4)
  await closeChanges(page)
  await page.getByRole('button', { name: 'Simulation', exact: true }).click()
  const simulation = page.getByRole('dialog', { name: 'Simulation controls' })
  await simulation.getByRole('button', { name: 'Reset demo…', exact: true }).click()
  await simulation.getByRole('button', { name: 'Confirm reset', exact: true }).click()
  await expect(operations(page)).toHaveCount(0)
  await expect(page.getByTestId('selection-count')).toContainText('0 selected')
  await page.clock.fastForward(4_000)
  const next = await snapshot(page)
  expect(next.sessionId).not.toBe(initial.sessionId)
  expect(next.deals.every((record) => record.version === 1 && record.stage === 'new-lead')).toBe(
    true,
  )
  expect(batches).toHaveLength(4)
})

test('filter changes announce selection clearing; sorting and native Space selection preserve the remaining IDs', async ({
  page,
}) => {
  await fixture(page, [0, 1, 12_000])
  await open(page)
  const selected = page.getByTestId('selection-count')
  const selectAll = page.getByRole('button', { name: 'Select all matching', exact: true })
  await selectAll.click()
  await page.getByRole('columnheader', { name: 'Company', exact: true }).click()
  await expect(selected).toContainText('3 selected')
  await page.locator('.ag-row[row-index="0"] [col-id="company"]').click()
  await page.keyboard.press('Space')
  await expect(selected).toContainText('2 selected')
  await page.keyboard.press('Space')
  await expect(selected).toContainText('3 selected')
  await selectDropdown(page.getByRole('combobox', { name: 'Stage', exact: true }), 'New Lead')
  await expect(selected).toContainText('0 selected')
  await expect(selected).toContainText('Selection cleared')
  await page.locator('.ag-row[row-index="0"] [col-id="ag-Grid-SelectionColumn"]').focus()
  await page.keyboard.press('Control+a')
  await expect(selected).toContainText('0 selected')
  await page.keyboard.press('Space')
  await expect(selected).toContainText('1 selected')
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click()
  await selectAll.click()
  await selectDropdown(page.getByRole('combobox', { name: 'Owner', exact: true }), 'Aarav Shah')
  await expect(selected).toContainText('0 selected')
  await selectAll.click()
  await expect(selected).toContainText('1 selected')
  await page.getByRole('button', { name: /^My deals/ }).click()
  await expect(selected).toContainText('0 selected')
  await selectAll.click()
  await page.getByRole('searchbox').fill('No such company')
  await expect(selected).toContainText('0 selected')
  await expect(selected).toContainText('Selection cleared')
})

test('pending single saves are explicitly skipped, and bulk reservations prevent overlapping stage editors', async ({
  page,
}) => {
  await fixture(page, [0, 1, 2])
  const initial = await open(page, 3_000)
  const stage = page.locator(`.ag-row[row-id="${initial.deals[0].id}"] [col-id="stage"]`)
  await stage.getByTestId('deal-stage').click()
  await chooseStage(page, 'contacted')
  await expect(stage.getByTestId('stage-feedback')).toHaveAttribute('data-state', 'saving')
  await page.getByRole('button', { name: 'Select all matching', exact: true }).click()
  await page.getByRole('button', { name: 'Review bulk move', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Review bulk stage change' })
  await expect(dialog.getByText('Already pending', { exact: true }).locator('+ dd')).toContainText(
    '1 —',
  )
  await dialog.getByRole('button', { name: 'Confirm bulk move' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Review bulk move', exact: true })).toBeFocused()
  const otherStage = page.locator(`.ag-row[row-id="${initial.deals[2].id}"] [col-id="stage"]`)
  await expect(otherStage.getByTestId('deal-stage')).toBeDisabled()
  await otherStage.focus()
  await page.keyboard.press('F2')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await openChanges(page)
  await expect(count(operations(page).first(), 'succeeded')).toHaveText('2')
  await expect(count(operations(page).first(), 'skipped')).toHaveText('1')
  await expect(page.getByTestId('operation-result')).toHaveAttribute('data-state', 'succeeded')
  expect((await snapshot(page)).deals.every((record) => record.version === 2)).toBe(true)
})

test('all 50,000 selected items reconcile exactly with bounded rendering and usable input during bulk processing', async ({
  page,
  browser,
}, testInfo) => {
  test.setTimeout(90_000)
  const { batches, peak } = capture(page)
  const initial = await open(page, 80)
  await page.evaluate(() => {
    const state = window as unknown as {
      fullBulkTasks: { startTime: number; duration: number }[]
      fullBulkObserver: PerformanceObserver
      fullBulkMarks: { name: string; at: number }[]
    }
    state.fullBulkTasks = []
    state.fullBulkMarks = [{ name: 'before selection', at: performance.now() }]
    state.fullBulkObserver = new PerformanceObserver((list) =>
      state.fullBulkTasks.push(
        ...list.getEntries().map(({ startTime, duration }) => ({ startTime, duration })),
      ),
    )
    state.fullBulkObserver.observe({ type: 'longtask' })
  })
  const mark = (name: string) =>
    page.evaluate((name) => {
      ;(window as unknown as { fullBulkMarks: { name: string; at: number }[] }).fullBulkMarks.push({
        name,
        at: performance.now(),
      })
    }, name)
  const selectedAt = performance.now()
  await page.getByRole('button', { name: 'Select all matching', exact: true }).click()
  await expect(page.getByTestId('selection-count')).toContainText('50,000 selected')
  await mark('after selection')
  const selectionMs = performance.now() - selectedAt
  const started = performance.now()
  await mark('before review')
  await page.getByRole('button', { name: 'Review bulk move', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Review bulk stage change' })).toBeVisible()
  await mark('review opened')
  await page.getByRole('button', { name: 'Confirm bulk move', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await mark('submitted')
  await expect.poll(() => batches.length).toBeGreaterThanOrEqual(4)
  const typingAt = performance.now()
  await page.getByRole('searchbox').fill('Atlas')
  await expect(page.getByRole('searchbox')).toHaveValue('Atlas')
  const inputMs = performance.now() - typingAt
  await openChanges(page)
  const operation = operations(page).first()
  await expect(count(operation, 'succeeded')).toHaveText('40,000', { timeout: 60_000 })
  await expect(count(operation, 'skipped')).toHaveText('10,000')
  await expect(count(operation, 'saving')).toHaveText('0')
  await expect(count(operation, 'queued')).toHaveText('0')
  const bulkMs = performance.now() - started
  await mark('all results complete')
  expect(batches).toHaveLength(200)
  expect(peak()).toBeLessThanOrEqual(4)
  expect(new Set(batches.flat().map((command) => command.dealId)).size).toBe(40_000)
  const mounted = await page.locator('.ag-row').count()
  expect(mounted).toBeLessThan(100)
  const longTasks = await page.evaluate(() => {
    const state = window as unknown as {
      fullBulkTasks: { startTime: number; duration: number }[]
      fullBulkObserver: PerformanceObserver
      fullBulkMarks: { name: string; at: number }[]
    }
    state.fullBulkTasks.push(
      ...state.fullBulkObserver
        .takeRecords()
        .map(({ startTime, duration }) => ({ startTime, duration })),
    )
    state.fullBulkObserver.disconnect()
    return {
      count: state.fullBulkTasks.length,
      totalMs: state.fullBulkTasks.reduce((a, b) => a + b.duration, 0),
      maxMs: Math.max(0, ...state.fullBulkTasks.map((task) => task.duration)),
      entries: state.fullBulkTasks,
      phases: state.fullBulkMarks,
    }
  })
  // This verification-only full snapshot is outside the measured interaction/queue interval.
  const current = await snapshot(page)
  const versions = new Map(
    initial.deals.map((record) => [record.id, record.stage === 'contacted' ? 1 : 2]),
  )
  expect(
    current.deals.every(
      (record) => record.stage === 'contacted' && record.version === versions.get(record.id),
    ),
  ).toBe(true)
  await testInfo.attach('stage5-full-volume-performance', {
    body: JSON.stringify(
      {
        selected: 50_000,
        committed: 40_000,
        skipped: 10_000,
        requests: batches.length,
        maxInFlight: peak(),
        batchSize: 200,
        selectionMs,
        inputMs,
        bulkMs,
        mounted,
        longTasks,
        browser: browser.version(),
        viewport: page.viewportSize(),
        production: process.env.PLAYWRIGHT_DEV !== '1',
        workers: testInfo.config.workers,
        simulationDelayMs: 80,
      },
      null,
      2,
    ),
    contentType: 'application/json',
  })
})

test('Retry of an older bulk failure shows current pending feedback and conflicts after a newer single-deal success', async ({
  page,
}) => {
  await fixture(page, [0, 1])
  const { batches } = capture(page)
  const initial = await open(page, 700)
  await control(page, '/faults', { fault: 'save-failure' })
  await page.getByRole('button', { name: 'Select all matching', exact: true }).click()
  await confirm(page)
  const operation = operations(page).first()
  await expect(count(operation, 'failed')).toHaveText('1')
  await expect(count(operation, 'succeeded')).toHaveText('1')
  const stage = page.locator(`.ag-row[row-id="${initial.deals[0].id}"] [col-id="stage"]`)
  await stage.getByTestId('deal-stage').click()
  await chooseStage(page, 'won')
  await expect(page.getByTestId('operation-result')).toHaveAttribute('data-state', 'succeeded')
  await operation.getByRole('button', { name: 'Retry eligible failed items' }).click()
  await expect(stage).toContainText('Won')
  await expect(stage).toContainText('Saving…')
  await expect(stage.locator('[title="Moving to Contacted"]')).toBeVisible()
  await expect(count(operation, 'conflicted')).toHaveText('1')
  await expect(stage.getByTestId('deal-stage')).toHaveText('Won')
  await expect(stage.getByRole('button', { name: /^Review conflict for/ })).toBeVisible()
  expect(batches[1]).toEqual([batches[0][0]])
  expect(batches[1][0].expectedVersion).toBe(1)
  await expect(page.getByTestId('operation-result')).toHaveAttribute('data-state', 'succeeded')
})
