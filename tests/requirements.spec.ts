import { expect, test } from '@playwright/test'
import { selectDropdown } from './helpers/dropdown'

test.use({ timezoneId: 'Asia/Kolkata' })

test('keyboard focus is visible in both themes while pointer controls retain their existing styling', async ({
  page,
}) => {
  await page.goto('/')
  await expect(page.getByRole('grid', { name: 'Sales pipeline deals' })).toBeVisible()
  for (const theme of ['Light', 'Dark']) {
    await selectDropdown(page.getByRole('combobox', { name: 'Appearance' }), theme)
    await page.getByRole('searchbox').focus()
    await page.keyboard.press('Tab')
    const owner = page.getByRole('combobox', { name: 'Owner', exact: true })
    await expect(owner).toBeFocused()
    expect(await owner.evaluate((el) => el.matches(':focus-visible'))).toBe(true)
    expect(await owner.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none')
    await page.locator('.ag-header-cell[col-id="company"]').focus()
    await page.keyboard.press('ArrowDown')
    const cell = page.locator('.ag-row[row-index="0"] [col-id="company"]')
    await expect(cell).toBeFocused()
    expect(await cell.evaluate((el) => getComputedStyle(el).boxShadow)).not.toBe('none')
    const all = page.getByRole('button', { name: /^All deals/ })
    await all.click()
    expect(await all.evaluate((el) => el.matches(':focus-visible'))).toBe(false)
    expect(await all.evaluate((el) => getComputedStyle(el).boxShadow)).toBe('none')
  }
  await page.emulateMedia({ forcedColors: 'active' })
  await page.getByRole('searchbox').focus()
  await page.keyboard.press('Tab')
  await expect(page.getByRole('combobox', { name: 'Owner', exact: true })).toHaveCSS(
    'outline-style',
    'solid',
  )
})

test('Updated today uses local midnight, includes closed stages, composes filters, and defers rollover while working', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.clock.install({ time: new Date('2026-11-18T18:29:00Z') })
  await page.addInitScript(() => {
    const original = window.fetch.bind(window)
    window.fetch = async (input, init) => {
      const response = await original(input, init)
      const path = new URL(input instanceof Request ? input.url : String(input), location.href)
        .pathname
      if (path === '/api/deals' && response.ok) {
        const body = await response.json()
        const times = ['2026-11-18T10:00:00Z', '2026-11-17T18:30:00Z', '2026-11-17T18:29:59Z']
        return new Response(
          JSON.stringify({
            ...body,
            deals: body.deals.slice(0, 3).map((deal: object, index: number) => ({
              ...deal,
              companyName: `Today fixture ${index}`,
              stage: index === 0 ? 'won' : 'new-lead',
              updatedAt: times[index],
            })),
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )
      }
      return response
    }
  })
  await page.goto('/')
  await expect(page.getByRole('grid', { name: 'Sales pipeline deals' })).toBeVisible()
  await page.getByRole('button', { name: /^Updated today/ }).click()
  await expect(page.getByTestId('matching-count')).toHaveText('2 matching deals')
  await expect(
    page
      .getByText('Stage updates today · Asia/Calcutta · All stages included')
      .or(page.getByText('Stage updates today · Asia/Kolkata · All stages included')),
  ).toBeVisible()
  await expect(page.locator('.ag-row[row-index="0"] [col-id="company"]')).toContainText(
    'Today fixture 0',
  )
  await selectDropdown(page.getByRole('combobox', { name: 'Stage', exact: true }), 'Won')
  await expect(page.getByTestId('matching-count')).toHaveText('1 matching deals')
  await page.getByRole('button', { name: 'Clear filters' }).click()
  await expect(page.getByTestId('matching-count')).toHaveText('2 matching deals')
  await page.getByRole('searchbox').focus()
  await page.clock.fastForward(60_001)
  await expect(page.getByRole('button', { name: /^Updated today/ })).toContainText('0')
  await expect(page.getByTestId('matching-count')).toHaveText('2 displayed deals')
  await expect(page.getByRole('searchbox')).toBeFocused()
  await page.getByRole('button', { name: 'Refresh today’s deals' }).click()
  await expect(page.getByTestId('matching-count')).toHaveText('0 matching deals')
})

test('cancelling a large selection preparation cannot publish obsolete membership or send a write', async ({
  page,
}) => {
  let writes = 0
  page.on('request', (request) => {
    if (
      (request.method() === 'PATCH' && request.url().includes('/api/deals/')) ||
      request.url().includes('/api/deals/bulk-move')
    )
      writes++
  })
  await page.goto('/')
  await expect(page.getByRole('grid', { name: 'Sales pipeline deals' })).toBeVisible()
  await page.evaluate(() => {
    const scope = window as unknown as {
      scheduler: { yield: () => Promise<void> }
      releasePreparation?: () => void
    }
    const original = scope.scheduler.yield.bind(scope.scheduler)
    scope.scheduler.yield = () => {
      scope.scheduler.yield = original
      return new Promise<void>((resolve) => {
        scope.releasePreparation = resolve
      })
    }
  })
  await page
    .getByRole('button', { name: 'Select all matching', exact: true })
    .evaluate((el: HTMLButtonElement) => el.click())
  await page.getByRole('button', { name: 'Cancel preparation', exact: true }).click()
  await page.evaluate(() => {
    ;(window as unknown as { releasePreparation: () => void }).releasePreparation()
  })
  await expect(page.getByTestId('selection-count')).toHaveText('0 selected')
  await page.getByRole('searchbox').fill('Cedar')
  await expect(page.getByTestId('matching-count')).not.toHaveText('50,000 matching deals')
  expect(writes).toBe(0)
})

test('50,000-item selection, review and submission stay within a main-thread task budget with 4× CPU slowdown', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000)
  await page.goto('/')
  await expect(page.getByRole('grid', { name: 'Sales pipeline deals' })).toBeVisible()
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
  await page.evaluate(() => {
    const state = window as unknown as { tasks: number[]; observer: PerformanceObserver }
    state.tasks = []
    state.observer = new PerformanceObserver((list) =>
      state.tasks.push(...list.getEntries().map((entry) => entry.duration)),
    )
    state.observer.observe({ type: 'longtask' })
  })
  await page.getByRole('button', { name: 'Select all matching', exact: true }).click()
  await expect(page.getByTestId('selection-count')).toContainText('50,000 selected')
  await page.getByRole('button', { name: 'Review bulk move', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Review bulk stage change' })).toBeVisible()
  await page.getByRole('button', { name: 'Confirm bulk move', exact: true }).click()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.getByRole('searchbox').fill('Atlas')
  await expect(page.getByRole('searchbox')).toHaveValue('Atlas')
  const tasks = await page.evaluate(() => {
    const state = window as unknown as { tasks: number[]; observer: PerformanceObserver }
    state.tasks.push(...state.observer.takeRecords().map((entry) => entry.duration))
    state.observer.disconnect()
    return state.tasks
  })
  const maxTaskMs = Math.max(0, ...tasks)
  await testInfo.attach('preparation-budget', {
    body: JSON.stringify({ cpuSlowdown: 4, maxTaskMs, tasks }),
    contentType: 'application/json',
  })
  expect(maxTaskMs).toBeLessThan(150)
  expect(await page.locator('.ag-row').count()).toBeLessThan(100)
})

test('cancelling command preparation rolls back reservations and never submits a partial bulk operation', async ({
  page,
}) => {
  let writes = 0
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url().includes('/api/deals/bulk-move')) writes++
  })
  await page.goto('/')
  await expect(page.getByRole('grid', { name: 'Sales pipeline deals' })).toBeVisible()
  await page.getByRole('button', { name: 'Select all matching', exact: true }).click()
  await expect(page.getByTestId('selection-count')).toContainText('50,000 selected')
  await page.getByRole('button', { name: 'Review bulk move', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Review bulk stage change' })
  await expect(dialog).toBeVisible()
  await page.evaluate(() => {
    const scope = window as unknown as {
      scheduler: { yield: () => Promise<void> }
      releaseCommands?: () => void
    }
    const original = scope.scheduler.yield.bind(scope.scheduler)
    scope.scheduler.yield = () => {
      scope.scheduler.yield = original
      return new Promise<void>((resolve) => {
        scope.releaseCommands = resolve
      })
    }
  })
  await dialog.getByRole('button', { name: 'Confirm bulk move', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(
    dialog.getByRole('button', { name: 'Confirm bulk move', exact: true }),
  ).toBeDisabled()
  await expect(dialog.getByRole('button', { name: 'Confirm bulk move', exact: true })).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(dialog.getByRole('button', { name: 'Cancel bulk review' })).toBeFocused()
  await page.keyboard.press('Enter')
  await page.evaluate(() => {
    ;(window as unknown as { releaseCommands: () => void }).releaseCommands()
  })
  await expect(dialog).toHaveCount(0)
  await expect(page.locator('[data-testid="stage-feedback"][data-state="queued"]')).toHaveCount(0)
  expect(writes).toBe(0)
  await expect(page.getByRole('button', { name: 'Review bulk move', exact: true })).toBeFocused()
})

test('a teammate update enters Updated today on explicit refresh without moving focus or silently changing membership', async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date('2026-11-18T08:00:00Z'))
  await page.goto('/')
  await expect(page.getByRole('grid', { name: 'Sales pipeline deals' })).toBeVisible()
  const today = page.getByRole('button', { name: /^Updated today/ })
  await today.click()
  const initial = Number(
    (await today.innerText()).replace('Updated today', '').replaceAll(',', '').trim(),
  )
  await page.getByRole('searchbox').focus()
  const name = await page.evaluate(async () => {
    const snapshot = await (await fetch('/api/deals')).json()
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const record = snapshot.deals.find(
      (deal: { updatedAt: string }) => Date.parse(deal.updatedAt) < start.getTime(),
    )
    const response = await fetch('/api/simulation/conflict', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dealId: record.id }),
    })
    if ((await response.json()).status !== 'succeeded')
      throw new Error('Teammate update did not commit')
    return record.companyName as string
  })
  await expect(today).toContainText(new Intl.NumberFormat('en-IN').format(initial + 1))
  await expect(page.getByRole('searchbox')).toBeFocused()
  await expect(page.getByTestId('matching-count')).toHaveText(
    `${new Intl.NumberFormat('en-IN').format(initial)} displayed deals`,
  )
  await page.getByRole('button', { name: 'Refresh list', exact: true }).click()
  await expect(page.getByTestId('matching-count')).toHaveText(
    `${new Intl.NumberFormat('en-IN').format(initial + 1)} matching deals`,
  )
  await expect(page.locator('.ag-row[row-index="0"] [col-id="company"]')).toContainText(name)
})
