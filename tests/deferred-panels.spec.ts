import { expect, test } from '@playwright/test'

test('optional panels load on demand and retain their close and focus behavior', async ({
  page,
}) => {
  test.skip(process.env.PLAYWRIGHT_DEV === '1', 'Checks the production chunk boundaries.')
  const panelRequests: string[] = []
  page.on('request', (request) => {
    if (/\/assets\/(ChangesPanel|SimulationPanelContent)-.*\.js$/.test(request.url()))
      panelRequests.push(request.url())
  })
  await page.goto('/')
  await expect(page.getByRole('grid', { name: 'Sales pipeline deals' })).toBeVisible()
  expect(panelRequests).toHaveLength(0)
  const changes = page.getByRole('button', { name: /^Changes/ })
  await changes.click()
  await expect(page.getByRole('heading', { name: 'Recent changes' })).toBeVisible()
  await page.getByRole('button', { name: 'Close changes panel' }).click()
  await expect(changes).toBeFocused()
  await changes.click()
  await expect(page.getByRole('heading', { name: 'Recent changes' })).toBeVisible()
  await page.getByRole('button', { name: 'Close changes panel' }).click()
  expect(panelRequests.filter((url) => url.includes('ChangesPanel-'))).toHaveLength(1)
  await page.getByRole('button', { name: 'Simulation', exact: true }).click()
  await expect(page.getByRole('dialog', { name: 'Simulation controls' })).toBeVisible()
  await page.getByRole('button', { name: 'Close simulation' }).click()
  await expect(page.getByRole('button', { name: 'Simulation', exact: true })).toBeFocused()
  expect(panelRequests.filter((url) => url.includes('SimulationPanelContent-'))).toHaveLength(1)
})

test('a failed optional-panel download can be retried without resetting the workspace', async ({
  page,
}) => {
  test.skip(process.env.PLAYWRIGHT_DEV === '1', 'Checks production module downloads.')
  let fail = true
  await page.context().route('**/assets/SimulationPanelContent-*.js', async (route) => {
    if (fail) {
      fail = false
      await route.abort()
    } else await route.continue()
  })
  await page.goto('/')
  await expect(page.getByRole('grid', { name: 'Sales pipeline deals' })).toBeVisible()
  const search = page.getByRole('searchbox')
  await search.fill('Atlas')
  await expect(page.getByTestId('matching-count')).not.toContainText('50,000')
  const session = await page.evaluate(
    async () => (await (await fetch('/api/deals')).json()).sessionId as string,
  )
  await page.getByRole('button', { name: 'Simulation', exact: true }).click()
  await page.getByRole('button', { name: 'Retry simulation controls' }).click()
  await expect(page.getByRole('dialog', { name: 'Simulation controls' })).toBeVisible()
  await page.getByRole('button', { name: 'Close simulation' }).click()
  await expect(search).toHaveValue('Atlas')
  expect(
    await page.evaluate(async () => (await (await fetch('/api/deals')).json()).sessionId as string),
  ).toBe(session)
})
