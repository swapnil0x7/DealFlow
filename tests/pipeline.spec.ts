import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import type { Deal } from '../src/domain/deal'
import { selectDropdown } from './helpers/dropdown'

const grid = (page: Page) => page.getByRole('grid', { name: 'Sales pipeline deals' })
const count = (page: Page) => page.getByTestId('matching-count')

async function openWorkspace(page: Page) {
  await page.goto('/')
  await expect(grid(page)).toBeVisible()
  await expect(grid(page)).toHaveAttribute('aria-rowcount', '50001')
}

test('full-volume filtering uses all rows, composes criteria, and does not reload the API', async ({ page }, testInfo) => {
  let loads = 0
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/deals') loads++ })
  const start = performance.now()
  await openWorkspace(page)
  const loadMs = performance.now() - start
  const mounted = page.locator('.ag-row')
  await expect(mounted.first()).toBeVisible()
  const initialMounted = await mounted.count()
  expect(initialMounted).toBeGreaterThan(0)
  expect(initialMounted).toBeLessThan(80)
  const initialLoads = loads
  const filterStart = performance.now()
  await page.getByRole('searchbox', { name: 'Search company' }).fill('  CEDAR  ')
  await selectDropdown(page.getByRole('combobox', { name: 'Owner', exact: true }), 'Aarav Shah')
  await selectDropdown(page.getByRole('combobox', { name: 'Stage', exact: true }), 'Contacted')
  await expect(count(page)).toContainText('250 matching deals')
  const filterMs = performance.now() - filterStart
  await expect(grid(page)).toHaveAttribute('aria-rowcount', '251')
  for (const row of await mounted.all()) {
    await expect(row).toContainText('Cedar')
    await expect(row).toContainText('Aarav Shah')
    await expect(row).toContainText('Contacted')
  }
  expect(loads).toBe(initialLoads)
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(count(page)).toContainText('50,000 matching deals')
  await expect(page.getByRole('searchbox')).toHaveValue('')
  await page.screenshot({ path: testInfo.outputPath('workspace.png'), fullPage: true })
  await testInfo.attach('initial-performance-baseline', { body: JSON.stringify({ loadMs, filterMs, initialMounted, dataset: 50_000, viewport: page.viewportSize() }), contentType: 'application/json' })
})

test('work views and owner criteria compose with an accessible empty state', async ({ page }) => {
  await openWorkspace(page)
  await page.getByRole('button', { name: /^My deals/ }).click()
  await expect(count(page)).toContainText('2,500 matching deals')
  await selectDropdown(page.getByRole('combobox', { name: 'Owner', exact: true }), 'Diya Rao')
  await expect(count(page)).toContainText('0 matching deals')
  await expect(page.locator('.ag-overlay-no-matching-rows-center')).toBeVisible()
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(count(page)).toContainText('2,500 matching deals')
  await expect(page.getByRole('button', { name: /^My deals/ })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: /^All deals/ }).click()
  await expect(count(page)).toContainText('50,000 matching deals')
})

test('filter alignment, concise counts, attention help and footer navigation work on desktop and mobile', async ({ page }, testInfo) => {
  await openWorkspace(page)
  await page.getByRole('button', { name: /^My deals/ }).click()
  await expect(count(page)).toHaveText('2,500 matching deals')
  const boxes = await Promise.all([
    page.getByRole('searchbox').boundingBox(),
    page.getByRole('combobox', { name: 'Owner', exact: true }).boundingBox(),
    page.getByRole('combobox', { name: 'Stage', exact: true }).boundingBox(),
  ])
  expect(boxes.map((box) => box!.height)).toEqual([44, 44, 44])
  expect(boxes.map((box) => box!.y)).toEqual([boxes[0]!.y, boxes[0]!.y, boxes[0]!.y])
  await page.screenshot({ path: testInfo.outputPath('filters-footer-desktop.png'), fullPage: true })
  const help = page.getByRole('button', { name: 'How attention works', exact: true })
  const tooltip = page.getByRole('tooltip')
  await help.hover()
  await expect(tooltip).toContainText('Clear reasons. No hidden scores.')
  await tooltip.hover()
  await tooltip.getByText('Inactive negotiations', { exact: true }).click()
  // Exceed the dismissal grace period to verify that readable hovered content remains open.
  await page.waitForTimeout(180)
  await expect(tooltip).toBeVisible()
  await page.getByRole('searchbox').click()
  await expect(tooltip).toHaveCount(0)
  await help.focus()
  await expect(tooltip).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(tooltip).toHaveCount(0)
  await expect(help).toBeFocused()
  await help.click()
  await expect(tooltip).toBeVisible()
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.setViewportSize({ width: 390, height: 844 })
  await help.scrollIntoViewIfNeeded()
  const tipBox = await tooltip.boundingBox()
  expect(tipBox!.x).toBeGreaterThanOrEqual(12)
  expect(tipBox!.x + tipBox!.width).toBeLessThanOrEqual(378)
  expect(tipBox!.y).toBeGreaterThanOrEqual(12)
  expect(tipBox!.y + tipBox!.height).toBeLessThanOrEqual(832)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('attention-help-mobile.png') })
  await help.click()
  await expect(tooltip).toHaveCount(0)
  await page.getByRole('link', { name: 'Back to filters' }).click()
  await expect(page.getByRole('searchbox')).toBeFocused()
  await page.locator('footer').screenshot({ path: testInfo.outputPath('footer-mobile.png') })
})

test('keyboard navigation reaches off-screen rows and leaves the grid predictably', async ({ page }, testInfo) => {
  await openWorkspace(page)
  const firstCell = page.locator('.ag-row[row-index="0"] [col-id="company"]')
  await page.getByRole('searchbox').focus()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('combobox', { name: 'Owner', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('combobox', { name: 'Stage', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'How attention works', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('button', { name: 'Select all matching', exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(page.locator('.ag-header-cell[col-id="ag-Grid-SelectionColumn"]')).toBeFocused()
  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('columnheader', { name: 'Company', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(firstCell).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.locator('.ag-row[row-index="1"] [col-id="company"]')).toBeFocused()
  const start = performance.now()
  await page.keyboard.press('End')
  const lastCell = page.locator('.ag-row[row-index="49999"] [col-id="status"]')
  await expect(lastCell).toBeFocused()
  await expect(lastCell).toBeInViewport()
  const lastRowMs = performance.now() - start
  expect(await page.locator('.ag-row').count()).toBeLessThan(80)
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Back to filters' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('searchbox')).toBeFocused()
  await testInfo.attach('keyboard-scroll-baseline', { body: JSON.stringify({ lastRowMs }), contentType: 'application/json' })
})

const NOW = Date.parse('2026-11-14T12:00:00Z')
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString()
const makeDeal = (id: string, stage: Deal['stage'], inactiveDays: number, valuePaise = 100_000_00): Deal => ({
  id, companyName: id, ownerId: 'owner-1', stage, valuePaise, createdAt: ago(30),
  lastActivityAt: ago(inactiveDays), updatedAt: ago(0), version: 1,
})
const fixtures: Deal[] = [
  makeDeal('Alpha closed', 'won', 30),
  makeDeal('Bravo inactive', 'contacted', 7),
  { ...makeDeal('Charlie lead', 'new-lead', 0), createdAt: ago(2) },
  makeDeal('Delta negotiation', 'negotiation', 14),
  makeDeal('Echo negotiation', 'negotiation', 20, 200),
  makeDeal('Foxtrot negotiation', 'negotiation', 20, 100),
  makeDeal('Golf fresh', 'contacted', 0),
  { ...makeDeal('Hotel no activity', 'demo-done', 0), createdAt: ago(7), lastActivityAt: null },
]

async function useFixtures(page: Page, records = fixtures, fixedTime = true) {
  if (fixedTime) await page.clock.setFixedTime(NOW)
  await page.addInitScript((deals) => {
    const originalFetch = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const response = await originalFetch(input, init)
      if (String(input).endsWith('/api/deals') && response.ok) {
        const snapshot = await response.json()
        return Response.json({ ...snapshot, deals })
      }
      return response
    }
  }, records)
  await page.goto('/')
  await expect(grid(page)).toBeVisible()
}

test('attention reasons and priority order match explicit fixed-date examples; user sorting stays available', async ({ page }) => {
  await useFixtures(page)
  await page.getByRole('button', { name: /^Needs attention/ }).click()
  await expect(count(page)).toContainText('6 matching deals')
  const companies = page.locator('.ag-row [col-id="company"] strong')
  await expect(companies).toHaveText(['Echo negotiation', 'Foxtrot negotiation', 'Delta negotiation', 'Charlie lead', 'Bravo inactive', 'Hotel no activity'])
  await expect(page.getByText('New lead waiting 2 days', { exact: true })).toBeVisible()
  await expect(page.getByText('Negotiation inactive for 14 days', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'How attention works', exact: true }).click()
  await expect(page.getByText('Clear reasons. No hidden scores.')).toBeVisible()
  await page.getByRole('button', { name: 'How attention works', exact: true }).click()
  await page.getByRole('columnheader', { name: 'Company', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(companies).toHaveText(['Bravo inactive', 'Charlie lead', 'Delta negotiation', 'Echo negotiation', 'Foxtrot negotiation', 'Hotel no activity'])
  await expect(page.getByText(/^Sorted by /)).toContainText('Company ascending')
})

test('time-based priority refresh is deferred during active work and applied explicitly', async ({ page }, testInfo) => {
  await page.clock.install({ time: NOW })
  const upcoming = { ...makeDeal('Upcoming lead', 'new-lead', 0), createdAt: new Date(NOW - 2 * 86_400_000 + 30_000).toISOString() }
  await useFixtures(page, [upcoming], false)
  await page.getByRole('button', { name: /^Needs attention/ }).click()
  await expect(count(page)).toContainText('0 matching deals')
  await page.getByRole('searchbox').focus()
  await page.clock.fastForward(60_001)
  await expect(page.getByText('Attention priorities changed. Refresh to update this list.')).toBeVisible()
  await expect(page.getByRole('button', { name: /^Needs attention/ })).toContainText('1')
  await expect(count(page)).toContainText('0 displayed deals')
  await expect(page.getByRole('searchbox')).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath('priority-notice.png') })
  await page.getByRole('button', { name: 'Refresh priorities' }).click()
  await expect(page.getByRole('button', { name: 'Refresh priorities' })).toHaveCount(0)
  await expect(count(page)).toContainText('1 matching deals')
  await expect(page.getByText('New lead waiting 2 days', { exact: true })).toBeVisible()
})

const upcomingLead = (): Deal => ({ ...makeDeal('Upcoming lead', 'new-lead', 0), createdAt: new Date(NOW - 2 * 86_400_000 + 30_000).toISOString() })
const refreshPriorities = (page: Page) => page.getByRole('button', { name: 'Refresh priorities', exact: true })

test('minutes of focused work without a real attention change produce no reminder or API reload', async ({ page }) => {
  await page.clock.install({ time: NOW })
  await useFixtures(page, fixtures, false)
  let reloads = 0
  page.on('request', (request) => { if (new URL(request.url()).pathname === '/api/deals') reloads++ })
  await page.getByRole('searchbox').focus()
  await page.clock.fastForward(5 * 60_000)
  await expect(refreshPriorities(page)).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Refresh list', exact: true })).toHaveCount(0)
  await expect(page.getByRole('searchbox')).toBeFocused()
  await expect(count(page)).toContainText('8 matching deals')
  expect(reloads).toBe(0)
})

test('All deals updates attention quietly while work is focused; the next minute does not create an alert', async ({ page }) => {
  await page.clock.install({ time: NOW })
  await useFixtures(page, [upcomingLead()], false)
  await page.getByRole('searchbox').focus()
  await page.clock.fastForward(60_001)
  await expect(page.getByText('New lead waiting 2 days', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Needs attention/ })).toContainText('1')
  await expect(refreshPriorities(page)).toHaveCount(0)
  await expect(count(page)).toContainText('1 matching deals')
  await page.clock.fastForward(60_001)
  await expect(refreshPriorities(page)).toHaveCount(0)
  await expect(page.getByRole('searchbox')).toBeFocused()
})

test('reason-only day changes and urgency changes that leave the order intact do not ask for refresh', async ({ page }) => {
  await page.clock.install({ time: NOW })
  await useFixtures(page, [{ ...makeDeal('Negotiation', 'negotiation', 0), lastActivityAt: new Date(NOW - 14 * 86_400_000 + 30_000).toISOString() }], false)
  await page.getByRole('button', { name: /^Needs attention/ }).click()
  await page.clock.fastForward(60_001)
  await expect(page.getByText('Negotiation inactive for 14 days', { exact: true })).toBeVisible()
  await expect(refreshPriorities(page)).toHaveCount(0)
  await page.clock.fastForward(86_400_000)
  await expect(page.getByText('Negotiation inactive for 15 days', { exact: true })).toBeVisible()
  await expect(refreshPriorities(page)).toHaveCount(0)
})

test('a threshold outside the current filters updates its badge without a refresh prompt', async ({ page }) => {
  await page.clock.install({ time: NOW })
  await useFixtures(page, [upcomingLead()], false)
  await page.getByRole('button', { name: /^Needs attention/ }).click()
  await selectDropdown(page.getByRole('combobox', { name: 'Owner', exact: true }), 'Diya Rao')
  await page.clock.fastForward(60_001)
  await expect(count(page)).toContainText('0 matching deals')
  await expect(page.getByRole('button', { name: /^Needs attention/ })).toContainText('1')
  await expect(refreshPriorities(page)).toHaveCount(0)
})

test('a real priority reorder waits once and explicit refresh preserves the focused deal and selection', async ({ page }) => {
  await page.clock.install({ time: NOW })
  const negotiation = { ...makeDeal('Negotiation', 'negotiation', 0), lastActivityAt: new Date(NOW - 14 * 86_400_000 + 30_000).toISOString() }
  await useFixtures(page, [negotiation, makeDeal('Lead', 'new-lead', 2)], false)
  await page.getByRole('button', { name: /^Needs attention/ }).click()
  const companies = page.locator('.ag-row [col-id="company"] strong')
  await expect(companies).toHaveText(['Lead', 'Negotiation'])
  const lead = page.locator('.ag-row[row-id="Lead"]')
  await lead.getByRole('checkbox').check()
  await lead.locator('[col-id="company"]').click()
  await page.clock.fastForward(60_001)
  await expect(companies).toHaveText(['Lead', 'Negotiation'])
  await expect(lead.locator('[col-id="company"]')).toBeFocused()
  await expect(refreshPriorities(page)).toHaveCount(1)
  await page.clock.fastForward(60_001)
  await expect(refreshPriorities(page)).toHaveCount(1)
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
  await page.clock.fastForward(1)
  await expect(companies).toHaveText(['Lead', 'Negotiation'])
  await lead.locator('[col-id="company"]').click()
  await refreshPriorities(page).click()
  await expect(companies).toHaveText(['Negotiation', 'Lead'])
  await expect(lead.locator('[col-id="company"]')).toBeFocused()
  await expect(lead.getByRole('checkbox')).toBeChecked()
  await expect(page.getByTestId('selection-count')).toContainText('1 selected')
  await page.clock.fastForward(60_001)
  await expect(refreshPriorities(page)).toHaveCount(0)
})

test('an idle workspace applies new attention membership quietly', async ({ page }) => {
  await page.clock.install({ time: NOW })
  await useFixtures(page, [upcomingLead()], false)
  await page.getByRole('button', { name: /^Needs attention/ }).click()
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
  await page.clock.fastForward(60_001)
  await expect(count(page)).toContainText('1 matching deals')
  await expect(refreshPriorities(page)).toHaveCount(0)
})

test('a pending change applies quietly when focus leaves the workspace and no selection is held', async ({ page }) => {
  await page.clock.install({ time: NOW })
  await useFixtures(page, [upcomingLead()], false)
  await page.getByRole('button', { name: /^Needs attention/ }).click()
  await page.getByRole('searchbox').focus()
  await page.clock.fastForward(60_001)
  await expect(refreshPriorities(page)).toBeVisible()
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
  await page.clock.fastForward(1)
  await expect(count(page)).toContainText('1 matching deals')
  await expect(refreshPriorities(page)).toHaveCount(0)
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true)
})

test('a clock-driven reorder preserves an open stage editor until the user cancels it', async ({ page }) => {
  await page.clock.install({ time: NOW })
  const negotiation = { ...makeDeal('Negotiation', 'negotiation', 0), lastActivityAt: new Date(NOW - 14 * 86_400_000 + 30_000).toISOString() }
  await useFixtures(page, [negotiation, makeDeal('Lead', 'new-lead', 2)], false)
  await page.getByRole('button', { name: /^Needs attention/ }).click()
  const cell = page.locator('.ag-row[row-id="Negotiation"] [col-id="stage"]')
  await cell.getByTestId('deal-stage').click()
  await expect(page.getByRole('listbox')).toBeVisible()
  await page.clock.fastForward(60_001)
  await expect(cell.locator('[role="combobox"]')).toBeVisible()
  await expect(page.getByRole('listbox')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(cell.getByRole('combobox')).toHaveCount(0)
  await expect(refreshPriorities(page)).toBeVisible()
  await expect(page.locator('.ag-row [col-id="company"] strong')).toHaveText(['Lead', 'Negotiation'])
  await expect(page.getByText('Negotiation inactive for 14 days', { exact: true })).toBeVisible()
  await expect(page.getByTestId('operation-result')).toHaveCount(0)
})

test('background tabs suspend priority work and catch up on return without replaying reminders', async ({ page }) => {
  await page.clock.install({ time: NOW })
  await useFixtures(page, [upcomingLead()], false)
  await page.getByRole('button', { name: /^Needs attention/ }).click()
  await page.evaluate(() => {
    (document.activeElement as HTMLElement)?.blur()
    Object.defineProperty(document, 'hidden', { configurable: true, value: true })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await page.clock.fastForward(3 * 86_400_000)
  await expect(count(page)).toContainText('0 matching deals')
  await expect(refreshPriorities(page)).toHaveCount(0)
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false })
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(count(page)).toContainText('1 matching deals')
  await expect(page.getByText('New lead waiting 4 days', { exact: true })).toBeVisible()
  await expect(refreshPriorities(page)).toHaveCount(0)
})

test('recent scrolling protects an unfocused list until the workspace becomes idle', async ({ page }) => {
  await page.clock.install({ time: NOW })
  await useFixtures(page, [upcomingLead()], false)
  await page.getByRole('button', { name: /^Needs attention/ }).click()
  await page.evaluate(() => (document.activeElement as HTMLElement)?.blur())
  await page.clock.fastForward(59_000)
  await grid(page).dispatchEvent('wheel')
  await page.clock.fastForward(1_001)
  await expect(count(page)).toContainText('0 displayed deals')
  await expect(refreshPriorities(page)).toBeVisible()
  await page.clock.fastForward(5_001)
  await expect(count(page)).toContainText('1 matching deals')
  await expect(refreshPriorities(page)).toHaveCount(0)
})

test('a portaled dropdown stays open when a threshold changes the active view', async ({ page }) => {
  await page.clock.install({ time: NOW })
  await useFixtures(page, [upcomingLead()], false)
  await page.getByRole('button', { name: /^Needs attention/ }).click()
  await page.getByRole('combobox', { name: 'Owner', exact: true }).click()
  await expect(page.getByRole('listbox')).toBeVisible()
  await page.clock.fastForward(60_001)
  await expect(page.getByRole('listbox')).toBeVisible()
  await expect(count(page)).toContainText('0 displayed deals')
  await page.keyboard.press('Escape')
  await expect(refreshPriorities(page)).toBeVisible()
  // Changing criteria accepts the current list and removes the old notice.
  await page.getByRole('button', { name: /^All deals/ }).click()
  await expect(refreshPriorities(page)).toHaveCount(0)
  await page.getByRole('button', { name: /^Needs attention/ }).click()
  await expect(count(page)).toContainText('1 matching deals')
})

test('workspace controls and rendered table pass axe; narrow view keeps overflow inside the table', async ({ page }) => {
  await openWorkspace(page)
  const results = await new AxeBuilder({ page }).analyze()
  expect(results.violations).toEqual([])
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByRole('searchbox')).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Owner', exact: true })).toBeVisible()
  await expect(page.getByRole('combobox', { name: 'Stage', exact: true })).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await expect(grid(page)).toBeVisible()
})


test('an empty repository has an explicit empty-data state', async ({ page }) => {
  await useFixtures(page, [])
  await expect(count(page)).toContainText('0 matching deals')
  await expect(page.locator('.ag-overlay-no-rows-center')).toBeVisible()
  await expect(grid(page)).toHaveAttribute('aria-rowcount', '1')
})
