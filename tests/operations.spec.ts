import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { Snapshot } from '../src/api/contracts'
import { STAGES, STAGE_LABELS } from '../src/domain/deal'
import type { Stage } from '../src/domain/deal'

async function control(page: Page, path: string, body: object, method = 'POST') {
  await page.evaluate(async ({ path, body, method }) => {
    const response = await fetch(`/api/simulation${path}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    if (!response.ok) throw new Error('Simulation control failed')
  }, { path, body, method })
}

async function setup(page: Page, delay = 0) {
  await page.goto('/')
  await expect(page.getByRole('grid', { name: 'Sales pipeline deals' })).toBeVisible()
  await control(page, '', { minSaveDelayMs: delay, maxSaveDelayMs: delay, failureRate: 0, changeDeliveryPaused: true }, 'PATCH')
  const snapshot = await page.evaluate(async () => await (await fetch('/api/deals')).json() as Snapshot)
  const record = snapshot.deals.at(-1)!
  await page.getByRole('searchbox').fill(record.companyName)
  await expect(page.getByTestId('matching-count')).toContainText('1 matching deals')
  return { record, sessionId: snapshot.sessionId, row: page.locator(`.ag-row[row-id="${record.id}"]`) }
}

async function edit(page: Page, row: Locator, stage: Stage) {
  const cell = row.locator('[col-id="stage"]')
  await cell.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('listbox')).toBeVisible()
  await page.keyboard.press('Home')
  for (let index = 0; index < STAGES.indexOf(stage); index++) await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(cell.locator('[role="combobox"]')).toHaveCount(0)
}

async function remoteMove(page: Page, sessionId: string, dealId: string, version: number, stage: Stage) {
  await page.evaluate(async ({ sessionId, dealId, version, stage }) => {
    const response = await fetch(`/api/deals/${dealId}`, { method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'X-DealDesk-Session': sessionId },
      body: JSON.stringify({ expectedVersion: version, stage, mutationId: crypto.randomUUID(), actorId: 'owner-2' }),
    })
    const result = await response.json()
    if (result.status !== 'succeeded') throw new Error('Teammate scenario failed')
  }, { sessionId, dealId, version, stage })
}

const results = (page: Page) => page.getByTestId('operation-result')

test('keyboard edit keeps confirmed values while saving, blocks overlap, supports Escape, then guarded Undo', async ({ page }, testInfo) => {
  const { row, record } = await setup(page, 900)
  const stage = row.locator('[col-id="stage"]')
  await stage.focus()
  await page.keyboard.press('F2')
  await expect(stage.locator('[role="combobox"]')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(stage.locator('[role="combobox"]')).toHaveCount(0)
  await expect(results(page)).toHaveCount(0)
  await edit(page, row, 'contacted')
  await expect(stage).toContainText(STAGE_LABELS[record.stage])
  await expect(stage).toContainText('Moving to Contacted')
  await page.keyboard.press('F2')
  await expect(stage.locator('[role="combobox"]')).toHaveCount(0)
  await expect(results(page).first()).toHaveAttribute('data-state', 'succeeded')
  await expect(stage).toHaveText('Contacted')
  await expect(stage).toBeFocused()
  await page.getByRole('button', { name: 'Undo move', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(results(page)).toHaveCount(2)
  await expect(results(page).first()).toHaveAttribute('data-state', 'succeeded')
  await expect(stage).toHaveText(STAGE_LABELS[record.stage])
  await expect(page.getByRole('button', { name: 'Undo move', exact: true })).toHaveCount(0)
  const saved = await page.evaluate(async (id) => (await (await fetch('/api/deals')).json() as Snapshot).deals.find((deal) => deal.id === id), record.id)
  expect(saved).toMatchObject({ stage: record.stage, version: record.version + 2, lastActivityAt: record.lastActivityAt })
  await page.screenshot({ path: testInfo.outputPath('single-deal-results.png'), fullPage: true })
})

test('definite failure retains confirmed stage; keyboard Retry preserves command identity', async ({ page }) => {
  const commands: Record<string, unknown>[] = []
  page.on('request', (request) => { if (request.method() === 'PATCH' && /\/api\/deals\//.test(request.url())) commands.push(request.postDataJSON()) })
  const { row, record } = await setup(page)
  await control(page, '/faults', { fault: 'save-failure' })
  await edit(page, row, 'contacted')
  await expect(results(page).first()).toHaveAttribute('data-state', 'failed')
  await expect(row.locator('[col-id="stage"]')).toContainText(STAGE_LABELS[record.stage])
  await page.getByRole('button', { name: 'Retry save' }).focus()
  await page.keyboard.press('Enter')
  await expect(results(page).first()).toHaveAttribute('data-state', 'succeeded')
  expect(commands).toHaveLength(2)
  expect(commands[1]).toEqual(commands[0])
  await expect(row.locator('[col-id="stage"]')).toHaveText('Contacted')
  await expect(results(page).first()).toBeFocused()
  await page.getByRole('button', { name: 'Dismiss result' }).focus()
  await page.keyboard.press('Enter')
  await expect(results(page)).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Recent changes' })).toBeFocused()
})

test('conflict review is labeled, restores focus, and submits a separately reviewed guarded change', async ({ page }) => {
  const { row, record, sessionId } = await setup(page)
  await remoteMove(page, sessionId, record.id, record.version, 'negotiation')
  await edit(page, row, 'contacted')
  await expect(results(page).first()).toHaveAttribute('data-state', 'conflicted')
  await expect(row.locator('[col-id="stage"]')).toContainText('Negotiation')
  const review = page.getByRole('button', { name: 'Review conflict' })
  await review.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('dialog', { name: 'Review stage conflict' })
  await expect(dialog).toContainText(`Negotiation (version ${record.version + 1})`)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.keyboard.press('Escape')
  await expect(review).toBeFocused()
  await page.keyboard.press('Enter')
  await dialog.getByRole('button', { name: 'Apply reviewed change' }).focus()
  await page.keyboard.press('Enter')
  await expect(dialog).toHaveCount(0)
  await expect(results(page)).toHaveCount(2)
  await expect(results(page).first()).toHaveAttribute('data-state', 'succeeded')
  await expect(results(page).nth(1)).toHaveAttribute('data-state', 'conflicted')
  await expect(page.getByRole('heading', { name: 'Recent changes' })).toBeFocused()
  await expect(row.locator('[col-id="stage"]')).toHaveText('Contacted')
})

test('lost response with unavailable reconciliation remains unconfirmed until explicit status checking', async ({ page }) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window)
    let interrupted = false
    window.fetch = async (input, init) => {
      if (!interrupted && String(input).includes('/api/operations/')) {
        interrupted = true
        throw new TypeError('Simulated interruption during reconciliation')
      }
      return originalFetch(input, init)
    }
  })
  const { row, record } = await setup(page)
  await control(page, '/faults', { fault: 'lost-response' })
  await edit(page, row, 'contacted')
  await expect(results(page).first()).toHaveAttribute('data-state', 'unconfirmed')
  await expect(row.locator('[col-id="stage"]')).toContainText(STAGE_LABELS[record.stage])
  await expect(page.getByRole('button', { name: 'Undo move' })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Dismiss result' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Check status', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(results(page).first()).toHaveAttribute('data-state', 'succeeded')
  await expect(row.locator('[col-id="stage"]')).toHaveText('Contacted')
  await expect(results(page).first()).toContainText('Attempt 1')
})

test('Undo conflicts after a teammate edit and keeps the original success visible', async ({ page }) => {
  const { row, record, sessionId } = await setup(page)
  await edit(page, row, 'contacted')
  await expect(results(page).first()).toHaveAttribute('data-state', 'succeeded')
  await remoteMove(page, sessionId, record.id, record.version + 1, 'won')
  await page.getByRole('button', { name: 'Undo move' }).click()
  await expect(results(page).first()).toHaveAttribute('data-state', 'conflicted')
  await expect(results(page).nth(1)).toHaveAttribute('data-state', 'succeeded')
  await expect(row.locator('[col-id="stage"]')).toContainText('Won')
  await expect(page.getByRole('button', { name: 'Undo move' })).toHaveCount(0)
})

test('saved rows stay inspectable until refresh applies stage-filter membership; results survive disappearing rows', async ({ page }) => {
  const { row, record } = await setup(page)
  await page.getByRole('combobox', { name: 'Stage', exact: true }).selectOption(record.stage)
  await edit(page, row, 'contacted')
  await expect(results(page).first()).toHaveAttribute('data-state', 'succeeded')
  await expect(row).toBeVisible()
  await expect(page.getByTestId('matching-count')).toContainText('1 displayed deals')
  await page.getByRole('button', { name: 'Refresh list', exact: true }).click()
  await expect(page.getByTestId('matching-count')).toContainText('0 matching deals')
  await expect(page.getByRole('searchbox')).toBeFocused()
  await expect(results(page).first()).toHaveAttribute('data-state', 'succeeded')
  await page.getByRole('button', { name: 'Undo move', exact: true }).click()
  await expect(results(page).first()).toHaveAttribute('data-state', 'succeeded')
  await page.getByRole('button', { name: 'Refresh list', exact: true }).click()
  await expect(row.locator('[col-id="stage"]')).toHaveText(STAGE_LABELS[record.stage])
})
