import { expect, test } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import { selectDropdown } from './helpers/dropdown'
import { chooseStage } from './helpers/stage'
import type { Snapshot } from '../src/api/contracts'

const gridName = 'Sales pipeline deals'

test('System follows the OS; explicit choices persist and override it', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await expect(page.getByRole('grid', { name: gridName })).toBeVisible()
  const root = page.locator('html')
  const appearance = page.getByRole('combobox', { name: 'Appearance', exact: true })
  await expect(root).toHaveAttribute('data-theme', 'dark')
  await expect(root).toHaveAttribute('data-ag-theme-mode', 'dark')
  await expect(appearance).toHaveText('System')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(root).toHaveAttribute('data-theme', 'light')
  await selectDropdown(appearance, 'Dark')
  await expect(root).toHaveAttribute('data-theme', 'dark')
  await page.reload()
  await expect(appearance).toHaveText('Dark')
  await expect(root).toHaveAttribute('data-theme', 'dark')
  await selectDropdown(appearance, 'Light')
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(root).toHaveAttribute('data-theme', 'light')
  await selectDropdown(appearance, 'System')
  await expect(root).toHaveAttribute('data-theme', 'dark')
  expect(await page.evaluate(() => localStorage.getItem('dealdesk:theme'))).toBe('system')
})

test('the saved theme is applied before the main application module loads', async ({ page }) => {
  test.skip(process.env.PLAYWRIGHT_DEV === '1', 'Checks production startup ordering.')
  await page.emulateMedia({ colorScheme: 'light' })
  await page.addInitScript(() => localStorage.setItem('dealdesk:theme', 'dark'))
  let release!: () => void
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  await page.context().route('**/assets/index-*.js', async (route) => {
    await held
    await route.continue()
  })
  try {
    await page.goto('/', { waitUntil: 'commit' })
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
    await expect(page.locator('html')).toHaveAttribute('data-ag-theme-mode', 'dark')
    expect(await page.evaluate(() => document.documentElement.style.colorScheme)).toBe('dark')
    await expect(page.getByRole('grid', { name: gridName })).toHaveCount(0)
  } finally {
    release()
  }
  await expect(page.getByRole('grid', { name: gridName })).toBeVisible()
})

test('blocked preference storage falls back to the system and appearance remains usable', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.addInitScript(() => {
    const getItem = Storage.prototype.getItem
    const setItem = Storage.prototype.setItem
    Storage.prototype.getItem = function (key) {
      if (key === 'dealdesk:theme') throw new DOMException('Storage denied', 'SecurityError')
      return getItem.call(this, key)
    }
    Storage.prototype.setItem = function (key, value) {
      if (key === 'dealdesk:theme') throw new DOMException('Storage denied', 'SecurityError')
      setItem.call(this, key, value)
    }
  })
  await page.goto('/')
  await expect(page.getByRole('grid', { name: gridName })).toBeVisible()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await selectDropdown(page.getByRole('combobox', { name: 'Appearance', exact: true }), 'Light')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light')
})

test('system changes preserve an open stage editor and its reviewed value', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.goto('/')
  await expect(page.getByRole('grid', { name: gridName })).toBeVisible()
  const stage = page.getByTestId('deal-stage').first()
  const previous = await stage.innerText()
  await stage.click()
  const menu = page.getByRole('listbox')
  await expect(menu).toBeVisible()
  await page.emulateMedia({ colorScheme: 'dark' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('option', { name: previous.trim(), exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  )
  await page.keyboard.press('Escape')
  await expect(stage).toHaveText(previous)
})

test('switching appearance preserves selection, filters, the grid instance, and a pending save', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const response = await original(input, init)
      const path = new URL(input instanceof Request ? input.url : String(input), location.href)
        .pathname
      if (init?.method === 'PATCH' && path.startsWith('/api/deals/')) {
        await new Promise<void>((resolve) => Object.assign(window, { releaseThemeSave: resolve }))
      }
      return response
    }
  })
  await page.goto('/')
  await expect(page.getByRole('grid', { name: gridName })).toBeVisible()
  await page.evaluate(async () => {
    await fetch('/api/simulation', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        minSaveDelayMs: 0,
        maxSaveDelayMs: 0,
        failureRate: 0,
        changeDeliveryPaused: true,
      }),
    })
  })
  await expect(page.getByTestId('connection-status')).toHaveText('Live updates paused')
  await page.getByRole('searchbox').fill('Atlas')
  await expect(page.getByTestId('matching-count')).toContainText('6,250 matching deals')
  const id = await page.locator('.ag-row[row-id]').first().getAttribute('row-id')
  const row = page.locator(`.ag-row[row-id="${id}"]`)
  await row.getByRole('checkbox').check()
  await row.getByTestId('deal-stage').click()
  await chooseStage(page, 'contacted')
  await expect
    .poll(() => page.evaluate(() => typeof Reflect.get(window, 'releaseThemeSave')))
    .toBe('function')
  await expect(row.getByTestId('stage-feedback')).toHaveAttribute('data-state', 'saving')
  await page.evaluate(() =>
    Object.assign(window, { themeGrid: document.querySelector('[role="grid"]') }),
  )
  let requests = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/')) requests++
  })
  await selectDropdown(page.getByRole('combobox', { name: 'Appearance', exact: true }), 'Dark')
  await expect(page.getByRole('searchbox')).toHaveValue('Atlas')
  await expect(page.getByTestId('selection-count')).toContainText('1 selected')
  await expect(row.getByTestId('stage-feedback')).toHaveAttribute('data-state', 'saving')
  expect(
    await page.evaluate(
      () => Reflect.get(window, 'themeGrid') === document.querySelector('[role="grid"]'),
    ),
  ).toBe(true)
  expect(requests).toBe(0)
  await page.evaluate(() => (Reflect.get(window, 'releaseThemeSave') as () => void)())
  await expect(row.getByTestId('stage-feedback')).toHaveAttribute('data-state', 'succeeded')
  await expect(row.getByTestId('deal-stage')).toContainText('Contacted')
})

test('dark grid, menus, tooltips, bulk review, and mobile layout use readable themed surfaces', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await expect(page.getByRole('grid', { name: gridName })).toBeVisible()
  expect(
    await page
      .getByRole('columnheader')
      .first()
      .evaluate((node) =>
        getComputedStyle(node).getPropertyValue('--ag-header-background-color').trim(),
      ),
  ).toBe('#1d3025')
  const audit = () => new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
  expect((await audit().analyze()).violations).toEqual([])
  await page.getByRole('combobox', { name: 'Owner', exact: true }).click()
  await expect(page.getByRole('listbox')).toHaveCSS('background-color', 'rgb(24, 39, 30)')
  expect((await audit().include('[role="listbox"]').analyze()).violations).toEqual([])
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'How attention works' }).hover()
  await expect(page.getByRole('tooltip')).toHaveCSS('background-color', 'rgb(24, 39, 30)')
  await page.keyboard.press('Escape')
  await page.getByRole('checkbox').first().check()
  await page.getByRole('button', { name: 'Review bulk move' }).click()
  const review = page.getByRole('dialog', { name: 'Review bulk stage change' })
  await expect(review).toHaveCSS('background-color', 'rgb(24, 39, 30)')
  expect((await audit().include('[role="dialog"]').analyze()).violations).toEqual([])
  await review.getByRole('button', { name: 'Cancel bulk review' }).click()
  await page.screenshot({ path: testInfo.outputPath('dark-desktop.png'), fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByRole('button', { name: 'Simulation', exact: true }).click()
  const simulation = page.getByRole('dialog', { name: 'Simulation controls' })
  await expect(simulation).toHaveCSS('background-color', 'rgb(24, 39, 30)')
  expect((await audit().include('[role="dialog"]').analyze()).violations).toEqual([])
  await page.getByRole('button', { name: 'Close simulation' }).click()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('dark-mobile.png'), fullPage: true })
})

test('theme changes in another tab synchronize without reloading the workspace', async ({
  page,
  context,
}) => {
  await page.goto('/')
  await expect(page.getByRole('grid', { name: gridName })).toBeVisible()
  await page.getByRole('searchbox').fill('Atlas')
  const other = await context.newPage()
  await other.goto('/')
  await expect(other.getByRole('grid', { name: gridName })).toBeVisible()
  await selectDropdown(other.getByRole('combobox', { name: 'Appearance', exact: true }), 'Dark')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  await expect(page.getByRole('searchbox')).toHaveValue('Atlas')
  await other.close()
})

test('dark conflict review and guarded Undo retain the confirmed version history', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await page.goto('/')
  await expect(page.getByRole('grid', { name: gridName })).toBeVisible()
  await page.evaluate(async () => {
    await fetch('/api/simulation', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        minSaveDelayMs: 0,
        maxSaveDelayMs: 0,
        failureRate: 0,
        changeDeliveryPaused: true,
      }),
    })
  })
  await expect(page.getByTestId('connection-status')).toHaveText('Live updates paused')
  const id = await page.locator('.ag-row[row-id]').first().getAttribute('row-id')
  const row = page.locator(`.ag-row[row-id="${id}"]`)
  await page.evaluate(async (dealId) => {
    const response = await fetch('/api/simulation/conflict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dealId }),
    })
    if (!response.ok) throw new Error('Could not create teammate edit')
  }, id)
  await row.getByTestId('deal-stage').click()
  await chooseStage(page, 'demo-done')
  await expect(row.getByTestId('stage-feedback')).toHaveAttribute('data-state', 'conflicted')
  await row.getByRole('button', { name: /^Review conflict for/ }).click()
  const panel = page.getByRole('dialog', { name: 'Change details', exact: true })
  await expect(panel).toHaveCSS('background-color', 'rgb(24, 39, 30)')
  await expect(panel.getByRole('region', { name: 'Compare stage changes' })).toBeVisible()
  expect(
    (
      await new AxeBuilder({ page })
        .include('[data-side-panel]')
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze()
    ).violations,
  ).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('dark-conflict.png'), fullPage: true })
  await panel.getByRole('button', { name: 'Move to Demo Done', exact: true }).click()
  await expect(row.getByTestId('deal-stage')).toContainText('Demo Done')
  await panel.getByRole('button', { name: 'Close changes panel' }).click()
  await row.getByRole('button', { name: /^Undo move for/ }).click()
  await expect(row.getByTestId('deal-stage')).toContainText('Contacted')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  const saved = await page.evaluate(async (id) => {
    const snapshot = (await (await fetch('/api/deals')).json()) as Snapshot
    return snapshot.deals.find((deal) => deal.id === id)
  }, id)
  expect(saved).toMatchObject({ version: 4, stage: 'contacted' })
})
