import { expect } from '@playwright/test'
import type { Page } from '@playwright/test'
import { STAGES, STAGE_LABELS } from '../../src/domain/deal'
import type { Stage } from '../../src/domain/deal'

/** Radix moves option focus asynchronously; wait for each keyboard destination. */
export async function chooseStage(page: Page, stage: Stage) {
  const menu = page.getByRole('listbox')
  await expect(menu).toBeVisible()
  await page.keyboard.press('Home')
  await expect(menu.getByRole('option', { name: STAGE_LABELS[STAGES[0]], exact: true })).toBeFocused()
  for (let index = 1; index <= STAGES.indexOf(stage); index++) {
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('option', { name: STAGE_LABELS[STAGES[index]], exact: true })).toBeFocused()
  }
  await page.keyboard.press('Enter')
  await expect(menu).toHaveCount(0)
}
