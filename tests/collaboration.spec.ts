import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { Snapshot } from '../src/api/contracts'
import type { Stage } from '../src/domain/deal'

async function setup(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('grid', { name: 'Sales pipeline deals' })).toBeVisible()
  const snapshot = await page.evaluate(async () => {
    await fetch('/api/simulation', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minSaveDelayMs: 0, maxSaveDelayMs: 0, failureRate: 0 }) })
    return await (await fetch('/api/deals')).json() as Snapshot
  })
  const record = snapshot.deals.at(-1)!
  await page.getByRole('searchbox').fill(record.companyName)
  await expect(page.getByTestId('matching-count')).toContainText('1 matching deals')
  const row = page.locator(`.ag-row[row-id="${record.id}"]`)
  return { record, snapshot, row, stage: row.locator('[col-id="stage"]') }
}

async function remote(page: Page, snapshot: Snapshot, stage: Stage, version: number) {
  const id = snapshot.deals.at(-1)!.id
  await page.evaluate(async ({ id, sessionId, stage, version }) => {
    const response = await fetch(`/api/deals/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-DealDesk-Session': sessionId },
      body: JSON.stringify({ expectedVersion: version, stage, actorId: 'owner-2', mutationId: crypto.randomUUID() }) })
    const result = await response.json()
    if (result.status !== 'succeeded') throw new Error(`Teammate move failed: ${JSON.stringify(result)}`)
  }, { id, sessionId: snapshot.sessionId, stage, version })
}

async function chooseContacted(page: Page) {
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
}

test('live changes preserve focus and filtered row identity, pause while hidden, and catch up without full reloads', async ({ page }) => {
  await page.clock.install()
  let fullLoads = 0
  let polls = 0
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname
    if (path === '/api/deals') fullLoads++
    if (path === '/api/changes') polls++
  })
  const { record, snapshot, row, stage } = await setup(page)
  await page.getByRole('combobox', { name: 'Stage', exact: true }).selectOption(record.stage)
  await stage.focus()
  const originalIndex = await row.getAttribute('row-index')
  const loads = fullLoads
  await remote(page, snapshot, 'contacted', record.version)
  await expect(stage).toHaveText('Contacted')
  await expect(stage).toBeFocused()
  await expect(row).toHaveAttribute('row-index', originalIndex!)
  await expect(row.getByText('No longer matches filters')).toBeVisible()
  expect(fullLoads).toBe(loads)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(page.getByTestId('connection-status')).toHaveText('Updates paused while hidden')
  const pausedPolls = polls
  await remote(page, snapshot, 'won', record.version + 1)
  await page.clock.fastForward(2_000)
  expect(polls).toBe(pausedPolls)
  await expect(stage).toHaveText('Contacted')
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(stage).toHaveText('Won')
  await expect(stage).toBeFocused()
  expect(fullLoads).toBe(loads)
  await page.getByRole('button', { name: 'Refresh list', exact: true }).click()
  await expect(page.getByTestId('matching-count')).toContainText('0 matching deals')
  await expect(page.getByRole('searchbox')).toBeFocused()
})

test('a teammate update during editing never silently replaces the captured version; Escape drains deferred values', async ({ page }) => {
  const commands: Record<string, unknown>[] = []
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && /\/api\/deals\//.test(request.url())) {
      const body = request.postDataJSON()
      if (body.actorId === 'owner-1') commands.push(body)
    }
  })
  const { record, snapshot, stage } = await setup(page)
  await stage.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('listbox')).toBeVisible()
  await remote(page, snapshot, 'won', record.version)
  await expect(page.getByText('1 updates received', { exact: true })).toBeVisible()
  await expect(stage.locator('[role="combobox"]')).toContainText('Lost')
  await page.keyboard.press('Escape')
  await page.keyboard.press('Escape')
  await expect(stage.locator('[role="combobox"]')).toHaveCount(0)
  await expect(stage).toHaveText('Won')
  await expect(page.getByTestId('operation-result')).toHaveCount(0)
  await stage.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('listbox')).toBeVisible()
  await remote(page, snapshot, 'negotiation', record.version + 1)
  await expect(page.getByText('2 updates received', { exact: true })).toBeVisible()
  await chooseContacted(page)
  await expect(page.getByTestId('operation-result').first()).toHaveAttribute('data-state', 'conflicted')
  expect(commands).toHaveLength(1)
  expect(commands[0].expectedVersion).toBe(record.version + 1)
  await expect(stage).toContainText('Negotiation')
})

test('a matching feed event confirms a save before a delayed HTTP failure without retrying or regressing a newer record', async ({ page }) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const response = await originalFetch(input, init)
      if (init?.method === 'PATCH' && String(input).includes('/api/deals/') && JSON.parse(String(init.body)).actorId === 'owner-1') {
        await new Promise<void>((resolve) => {
          (window as Window & { releaseSave?: () => void }).releaseSave = resolve
        })
        document.documentElement.dataset.lateSaveError = 'delivered'
        throw new TypeError('Response interrupted after commit')
      }
      return response
    }
  })
  const { record, stage, snapshot } = await setup(page)
  await stage.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('listbox')).toBeVisible()
  await chooseContacted(page)
  await expect(page.getByTestId('operation-result').first()).toHaveAttribute('data-state', 'succeeded')
  expect(await page.evaluate(() => document.documentElement.dataset.lateSaveError)).toBeUndefined()
  await remote(page, snapshot, 'won', record.version + 1)
  await expect(stage).toHaveText('Won')
  await expect(page.getByRole('button', { name: 'Undo move', exact: true })).toHaveCount(0)
  await page.evaluate(() => (window as Window & { releaseSave?: () => void }).releaseSave?.())
  await expect(page.locator('html')).toHaveAttribute('data-late-save-error', 'delivered')
  await expect(page.getByTestId('operation-result').first()).toHaveAttribute('data-state', 'succeeded')
  await expect(stage).toHaveText('Won')
  const saved = await page.evaluate(async (id) => (await (await fetch('/api/deals')).json() as Snapshot).deals.find((item) => item.id === id), record.id)
  expect(saved?.version).toBe(record.version + 2)
})

test('simulation controls generate teammate writes, pause offline polling, reconnect, and work by keyboard', async ({ page }, testInfo) => {
  await page.clock.install()
  let fullLoads = 0
  let polls = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/deals') fullLoads++
    if (new URL(request.url()).pathname === '/api/changes') polls++
  })
  await page.goto('/')
  await expect(page.getByRole('grid', { name: 'Sales pipeline deals' })).toBeVisible()
  const initialLoads = fullLoads
  expect(initialLoads).toBeGreaterThan(0)
  const trigger = page.getByRole('button', { name: 'Simulation', exact: true })
  await trigger.focus(); await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Simulation controls' })
  await dialog.getByLabel('Minimum save delay (ms)').fill('0')
  await dialog.getByLabel('Maximum save delay (ms)').fill('0')
  await dialog.getByLabel('Save failure rate (%)').fill('0')
  await dialog.getByLabel('Teammate interval (ms)').fill('500')
  await dialog.getByRole('checkbox', { name: 'Simulate teammate activity' }).focus()
  await page.keyboard.press('Space')
  await dialog.getByRole('button', { name: 'Apply settings' }).focus(); await page.keyboard.press('Enter')
  await expect(dialog.getByRole('status')).toHaveText('Simulation settings applied.')
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await dialog.evaluate((element) => { element.scrollTop = 0 })
  await page.screenshot({ path: testInfo.outputPath('simulation-controls.png'), fullPage: true })
  await page.keyboard.press('Escape')
  await expect(trigger).toBeFocused()
  await expect.poll(async () => Number((await page.getByText(/updates received$/).textContent())?.split(' ')[0])).toBeGreaterThan(0)
  expect(fullLoads).toBe(initialLoads)
  await trigger.click()
  await dialog.getByRole('checkbox', { name: 'Offline simulation' }).check()
  await dialog.getByRole('button', { name: 'Apply settings' }).click()
  await expect(page.getByTestId('connection-status')).toHaveText('Offline')
  const paused = polls
  await page.clock.fastForward(2_000)
  expect(polls).toBe(paused)
  await dialog.getByRole('checkbox', { name: 'Offline simulation' }).uncheck()
  await dialog.getByRole('checkbox', { name: 'Simulate teammate activity' }).uncheck()
  await dialog.getByRole('button', { name: 'Apply settings' }).click()
  await dialog.getByRole('button', { name: 'Close simulation' }).click()
  await expect(page.getByTestId('connection-status')).toHaveText('Live updates connected')
  expect(fullLoads).toBe(initialLoads)
})

test('the unseen-edit scenario targets the last focused deal and leads to explicit conflict review', async ({ page }) => {
  const { stage, record } = await setup(page)
  await stage.click()
  await page.getByRole('button', { name: 'Simulation', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Simulation controls' })
  await expect(dialog).toContainText(record.companyName)
  await dialog.getByRole('button', { name: 'Create unseen teammate edit' }).click()
  await expect(dialog.getByRole('status')).toContainText('A teammate changed this deal.')
  await expect(dialog.getByRole('checkbox', { name: 'Pause change delivery' })).toBeChecked()
  await dialog.getByRole('button', { name: 'Close simulation' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Simulation', exact: true })).toBeFocused()
  await stage.click(); await page.keyboard.press('Enter')
  await expect(page.getByRole('listbox')).toBeVisible()
  await chooseContacted(page)
  await expect(page.getByTestId('operation-result').first()).toHaveAttribute('data-state', 'conflicted')
  await expect(page.getByRole('button', { name: 'Review conflict' })).toBeVisible()
})

test('warned reset cancels old saves and clears filters, results, focus target, and live-update state', async ({ page }) => {
  await page.clock.install()
  const { record, stage, snapshot } = await setup(page)
  await page.evaluate(async () => {
    await fetch('/api/simulation', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ minSaveDelayMs: 3_000, maxSaveDelayMs: 3_000 }) })
  })
  await stage.focus(); await page.keyboard.press('Enter')
  await expect(page.getByRole('listbox')).toBeVisible()
  await chooseContacted(page)
  await expect(page.getByTestId('operation-result').first()).toHaveAttribute('data-state', 'saving')
  await page.getByRole('button', { name: 'Simulation', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Simulation controls' })
  await dialog.getByRole('button', { name: 'Reset demo…', exact: true }).click()
  await expect(dialog.getByText(/Reset clears saved changes/)).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Cancel reset' })).toBeFocused()
  await dialog.getByRole('button', { name: 'Cancel reset' }).click()
  await expect(page.getByTestId('operation-result')).toHaveCount(1)
  await dialog.getByRole('button', { name: 'Reset demo…', exact: true }).click()
  await dialog.getByRole('button', { name: 'Confirm reset', exact: true }).click()
  await expect(page.getByRole('searchbox')).toHaveValue('')
  await expect(page.getByTestId('matching-count')).toContainText('50,000 matching deals')
  await expect(page.getByTestId('operation-result')).toHaveCount(0)
  await page.clock.fastForward(4_000)
  const next = await page.evaluate(async () => await (await fetch('/api/deals')).json() as Snapshot)
  expect(next.sessionId).not.toBe(snapshot.sessionId)
  expect(next.deals.find((item) => item.id === record.id)).toMatchObject({ stage: record.stage, version: 1 })
  await page.getByRole('button', { name: 'Simulation', exact: true }).click()
  await expect(dialog).toContainText('Focus a deal in the table first')
  await expect(dialog.getByRole('checkbox', { name: 'Simulate teammate activity' })).not.toBeChecked()
})

test('an expired feed cursor resyncs once and preserves a version captured by an open editor', async ({ page }) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const response = await originalFetch(input, init)
      if (String(input).includes('/api/changes?') && document.documentElement.dataset.expireFeed === 'yes') {
        delete document.documentElement.dataset.expireFeed
        const body = await response.json()
        return Response.json({ ...body, changes: [], resyncRequired: true, hasMore: false })
      }
      return response
    }
  })
  let fullLoads = 0
  const commands: Record<string, unknown>[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/deals') fullLoads++
    if (request.method() === 'PATCH' && /\/api\/deals\//.test(request.url())) {
      const body = request.postDataJSON()
      if (body.actorId === 'owner-1') commands.push(body)
    }
  })
  const { record, snapshot, stage } = await setup(page)
  await stage.focus(); await page.keyboard.press('Enter')
  await expect(page.getByRole('listbox')).toBeVisible()
  const initialLoads = fullLoads
  await page.evaluate(() => { document.documentElement.dataset.expireFeed = 'yes' })
  await remote(page, snapshot, 'won', record.version)
  await expect.poll(() => fullLoads).toBe(initialLoads + 1)
  await expect(page.getByTestId('connection-status')).toHaveText('Live updates connected')
  await chooseContacted(page)
  await expect(page.getByTestId('operation-result').first()).toHaveAttribute('data-state', 'conflicted')
  expect(commands[0].expectedVersion).toBe(record.version)
  expect(fullLoads).toBe(initialLoads + 1)
})

test('full-volume live updates preserve off-screen navigation and scroll until an explicit refresh reorders the same deal', async ({ page }) => {
  await page.goto('/')
  const grid = page.getByRole('grid', { name: 'Sales pipeline deals' })
  await expect(grid).toHaveAttribute('aria-rowcount', '50001')
  await page.evaluate(async () => {
    await fetch('/api/simulation', { method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minSaveDelayMs: 0, maxSaveDelayMs: 0, failureRate: 0 }) })
  })
  await page.getByRole('columnheader', { name: 'Stage', exact: true }).click()
  await page.locator('.ag-row[row-index="0"] [col-id="company"]').focus()
  await page.keyboard.press('End')
  const lastRow = page.locator('.ag-row[row-index="49999"]')
  const id = await lastRow.getAttribute('row-id')
  const cell = lastRow.locator('[col-id="status"]')
  await expect(cell).toBeFocused()
  const scrollPositions = () => grid.evaluate((root) => [root, ...Array.from(root.querySelectorAll<HTMLElement>('*'))]
    .filter((element) => element.scrollTop > 0).map((element) => ({ className: element.getAttribute('class'), top: element.scrollTop })))
  const before = await scrollPositions()
  expect(before.length).toBeGreaterThan(0)
  await page.evaluate(async (id) => {
    const snapshot = await (await fetch('/api/deals')).json() as Snapshot
    const record = snapshot.deals.find((item) => item.id === id)!
    const result = await (await fetch(`/api/deals/${id}`, { method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-DealDesk-Session': snapshot.sessionId },
      body: JSON.stringify({ stage: 'new-lead', expectedVersion: record.version, mutationId: crypto.randomUUID(), actorId: 'owner-2' }),
    })).json()
    if (result.status !== 'succeeded') throw new Error('Teammate edit failed')
  }, id)
  await expect(lastRow.locator('[col-id="stage"]')).toHaveText('New Lead')
  await expect(cell).toBeFocused()
  expect(await scrollPositions()).toEqual(before)
  await page.getByRole('button', { name: 'Refresh list', exact: true }).click()
  const moved = page.locator(`.ag-row[row-id="${id}"]`)
  await expect(moved.locator('[col-id="status"]')).toBeFocused()
  await expect(moved).toBeInViewport()
  expect(await moved.getAttribute('row-index')).not.toBe('49999')
})
