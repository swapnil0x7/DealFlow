import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import type { Deal } from '../src/domain/deal'

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
  await page.getByRole('combobox', { name: 'Owner', exact: true }).selectOption('owner-1')
  await page.getByRole('combobox', { name: 'Stage', exact: true }).selectOption('contacted')
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
  await page.getByRole('combobox', { name: 'Owner', exact: true }).selectOption('owner-2')
  await expect(count(page)).toContainText('0 matching deals')
  await expect(page.locator('.ag-overlay-no-matching-rows-center')).toBeVisible()
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(count(page)).toContainText('2,500 matching deals')
  await expect(page.getByRole('button', { name: /^My deals/ })).toHaveAttribute('aria-pressed', 'true')
  await page.getByRole('button', { name: /^All deals/ }).click()
  await expect(count(page)).toContainText('50,000 matching deals')
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
  await expect(page.getByText('How attention works', { exact: true })).toBeFocused()
  await page.keyboard.press('Tab')
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
  await page.getByText('How attention works', { exact: true }).click()
  await expect(page.getByText('Clear reasons. No hidden scores.')).toBeVisible()
  await page.getByText('How attention works', { exact: true }).click()
  await page.getByRole('columnheader', { name: 'Company', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(companies).toHaveText(['Bravo inactive', 'Charlie lead', 'Delta negotiation', 'Echo negotiation', 'Foxtrot negotiation', 'Hotel no activity'])
  await expect(page.getByText(/^Sorted by /)).toContainText('Company ascending')
})

test('time-based priority refresh is deferred during active work and applied explicitly', async ({ page }) => {
  await page.clock.install({ time: NOW })
  const upcoming = { ...makeDeal('Upcoming lead', 'new-lead', 0), createdAt: new Date(NOW - 2 * 86_400_000 + 30_000).toISOString() }
  await useFixtures(page, [upcoming], false)
  await page.getByRole('button', { name: /^Needs attention/ }).click()
  await expect(count(page)).toContainText('0 matching deals')
  await page.getByRole('searchbox').focus()
  await page.clock.fastForward(60_001)
  await expect(page.getByText('Time-based priorities may have changed.')).toBeVisible()
  await page.getByRole('button', { name: 'Refresh priorities' }).click()
  await expect(page.getByRole('button', { name: 'Refresh priorities' })).toHaveCount(0)
  await expect(count(page)).toContainText('1 matching deals')
  await expect(page.getByText('New lead waiting 2 days', { exact: true })).toBeVisible()
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
