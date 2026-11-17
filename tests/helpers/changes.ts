import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'

export const changesPanel = (page: Page) => page.locator('[data-side-panel]')

export async function openChanges(page: Page) {
  const panel = changesPanel(page)
  if (!(await panel.isVisible())) await page.getByRole('button', { name: /^Changes/ }).click()
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: /^(← )?All changes$/ }).click()
  await expect(panel.getByRole('button', { name: 'All changes', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  return panel
}

export async function closeChanges(page: Page) {
  if (await changesPanel(page).isVisible())
    await changesPanel(page).getByRole('button', { name: 'Close changes panel' }).click()
  await expect(changesPanel(page)).toHaveCount(0)
}
