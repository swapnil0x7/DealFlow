import { expect, test } from '@playwright/test'
import { deal, NOW } from '../src/test/fixtures'

test('activity and attention tooltips work without development validation warnings', async ({
  page,
}) => {
  const diagnostics: string[] = []
  page.on('console', (message) => {
    if (
      ['warning', 'error'].includes(message.type()) &&
      /AG Grid|tooltipValueGetter/i.test(message.text())
    )
      diagnostics.push(message.text())
  })
  page.on('pageerror', (error) => diagnostics.push(error.message))
  await page.clock.setFixedTime(NOW)
  await page.addInitScript(
    (deals) => {
      const originalFetch = window.fetch.bind(window)
      window.fetch = async (input, init) => {
        const response = await originalFetch(input, init)
        if (String(input).endsWith('/api/deals') && response.ok) {
          const snapshot = await response.json()
          return Response.json({ ...snapshot, deals })
        }
        return response
      }
    },
    [
      { ...deal, companyName: 'A recorded activity', lastActivityAt: '2026-11-13T00:00:00.000Z' },
      { ...deal, id: 'deal-2', companyName: 'B missing activity' },
    ],
  )
  await page.goto('/')
  await expect(page.getByRole('grid', { name: 'Sales pipeline deals' })).toBeVisible()
  await page.locator('.ag-row[row-index="0"] [col-id="activity"]').hover()
  await expect(
    page.getByRole('tooltip', { name: 'Last customer activity: 13 Nov 2026', exact: true }),
  ).toBeVisible()
  await page.locator('.ag-row[row-index="1"] [col-id="activity"]').hover()
  await expect(
    page.getByRole('tooltip', {
      name: 'No recorded customer activity. Attention uses creation date: 1 Oct 2026',
      exact: true,
    }),
  ).toBeVisible()
  await page.locator('.ag-row[row-index="1"] [col-id="attention"]').hover()
  await expect(
    page.getByRole('tooltip', { name: 'New lead waiting 44 days', exact: true }),
  ).toBeVisible()
  await expect(page.getByText(/AG Grid found.*deprecation/i)).toHaveCount(0)
  expect(diagnostics).toEqual([])
})
