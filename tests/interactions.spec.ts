import { expect, test } from '@playwright/test'
import { selectDropdown } from './helpers/dropdown'

test('the view indicator follows rapid changes and responsive layout without replacing the grid', async ({
  page,
}) => {
  let loads = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/deals') loads++
  })
  await page.goto('/')
  const grid = page.getByRole('grid', { name: 'Sales pipeline deals' })
  await expect(grid).toBeVisible()
  const original = await grid.elementHandle()
  const views = page.getByRole('group', { name: 'Work views', exact: true })
  const marker = views.locator(':scope > span[aria-hidden="true"]')
  const selected = views.locator('[aria-pressed="true"]')
  const initialLoads = loads
  await views.getByRole('button', { name: /^My deals/ }).click()
  await expect(page.getByTestId('matching-count')).toHaveText('2,500 matching deals')
  await views.getByRole('button', { name: /^Needs attention/ }).click()
  await views.getByRole('button', { name: /^All deals/ }).click()
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 })
    await expect
      .poll(async () => {
        const active = await selected.boundingBox()
        const underline = await marker.boundingBox()
        return Boolean(
          active &&
            underline &&
            Math.abs(active.x - underline.x) < 1 &&
            Math.abs(active.width - underline.width) < 1 &&
            Math.abs(active.y + active.height - underline.y - underline.height) < 1,
        )
      })
      .toBe(true)
  }
  expect(await grid.evaluate((element, previous) => element === previous, original)).toBe(true)
  expect(loads).toBe(initialLoads)
  await expect(grid).toHaveAttribute('aria-rowcount', '50001')
})

test('cell hover feedback does not resize the row or change selection', async ({
  page,
}, testInfo) => {
  await page.goto('/')
  const cell = page.locator('.ag-row[row-index="0"] [col-id="company"]')
  await expect(cell).toBeVisible()
  const before = await cell.boundingBox()
  const background = await cell.evaluate((element) => getComputedStyle(element).backgroundColor)
  await cell.hover()
  await expect
    .poll(() => cell.evaluate((element) => getComputedStyle(element).backgroundColor))
    .not.toBe(background)
  expect(await cell.boundingBox()).toEqual(before)
  await expect(page.getByText('0 selected', { exact: true })).toBeVisible()
  await page.screenshot({ path: testInfo.outputPath('cell-hover-light.png'), fullPage: true })
  await selectDropdown(page.getByRole('combobox', { name: 'Appearance' }), 'Dark')
  await cell.hover()
  await page.screenshot({ path: testInfo.outputPath('cell-hover-dark.png'), fullPage: true })
})

test('table page controls scroll virtual rows while End navigation remains immediate', async ({
  page,
}) => {
  await page.goto('/')
  const grid = page.getByRole('grid', { name: 'Sales pipeline deals' })
  await expect(grid).toBeVisible()
  const viewport = page.locator('.ag-grid-viewport')
  const original = await grid.elementHandle()
  await page.getByRole('button', { name: 'Scroll deals down' }).click()
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(100)
  await page.getByRole('button', { name: 'Scroll deals up' }).click()
  await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBe(0)
  await page.locator('.ag-row[row-index="0"] [col-id="company"]').click()
  await page.keyboard.press('End')
  await expect(page.locator('.ag-row[row-index="49999"] [col-id="status"]')).toBeFocused()
  expect(await page.locator('.ag-row').count()).toBeLessThan(80)
  expect(await grid.evaluate((element, previous) => element === previous, original)).toBe(true)
})

test('panel exit retains its content and a quick reopen keeps focus in the panel', async ({
  page,
}, testInfo) => {
  await page.goto('/')
  const changes = page.getByRole('button', { name: /^Changes/ })
  await changes.click()
  const panel = page.locator('[data-side-panel]')
  const heading = panel.getByRole('heading', { name: 'Recent changes' })
  await expect(heading).toBeFocused()
  await page.screenshot({ path: testInfo.outputPath('changes-panel.png') })
  const body = await panel.innerText()
  // The same event task observes the closing frame before CSS animation completion.
  await panel
    .getByRole('button', { name: 'Close changes panel' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(panel).toHaveAttribute('data-state', 'closed')
  expect(await panel.innerText()).toBe(body)
  await changes.evaluate((button: HTMLButtonElement) => button.click())
  await expect(panel).toHaveAttribute('data-state', 'open')
  await expect(heading).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(changes).toBeFocused()
})

test('closing a bulk review retains its reviewed content during exit and submits nothing', async ({
  page,
}) => {
  let writes = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/deals/bulk-move')) writes++
  })
  await page.goto('/')
  const checkbox = page.locator('.ag-row[row-index="0"] input[type="checkbox"]')
  await checkbox.check()
  const review = page.getByRole('button', { name: 'Review bulk move' })
  await review.click()
  const dialog = page.locator('[data-motion="modal"]')
  await expect(dialog).toBeVisible()
  const before = await dialog.innerText()
  await dialog
    .getByRole('button', { name: 'Cancel bulk review' })
    .evaluate((button: HTMLButtonElement) => button.click())
  await expect(dialog).toHaveAttribute('data-state', 'closed')
  expect(await dialog.innerText()).toBe(before)
  await expect(dialog).toHaveCount(0)
  await expect(review).toBeFocused()
  expect(writes).toBe(0)
})

test('reduced motion disables transitions and keeps mobile modal focus and cleanup intact', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/')
  const changes = page.getByRole('button', { name: /^Changes/ })
  await changes.click()
  const panel = page.locator('[data-side-panel]')
  await expect(panel.getByRole('heading', { name: 'Recent changes' })).toBeFocused()
  expect(await panel.evaluate((element) => getComputedStyle(element).animationName)).toBe('none')
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
  await expect(changes).toBeFocused()
  await page.getByRole('button', { name: /^My deals/ }).click()
  const marker = page
    .getByRole('group', { name: 'Work views', exact: true })
    .locator(':scope > span')
  expect(await marker.evaluate((element) => getComputedStyle(element).transitionDuration)).toBe(
    '0s',
  )
  const simulation = page.getByRole('button', { name: 'Simulation', exact: true })
  await simulation.click()
  const dialog = page.getByRole('dialog', { name: 'Simulation controls' })
  expect(await dialog.evaluate((element) => getComputedStyle(element).animationName)).toBe('none')
  await dialog.getByRole('button', { name: 'Close simulation' }).click()
  await expect(dialog).toHaveCount(0)
  await expect(simulation).toBeFocused()
  expect(await page.evaluate(() => getComputedStyle(document.body).pointerEvents)).not.toBe('none')
})
