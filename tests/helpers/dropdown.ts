import { expect } from '@playwright/test'
import type { Locator } from '@playwright/test'

export async function selectDropdown(trigger: Locator, label: string | RegExp) {
  await trigger.click()
  const menu = trigger.page().getByRole('listbox')
  await expect(menu).toBeVisible()
  await menu.getByRole('option', { name: label, exact: typeof label === 'string' }).click()
  await expect(menu).toHaveCount(0)
  await expect(trigger).toBeFocused()
}
