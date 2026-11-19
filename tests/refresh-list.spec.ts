import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { chooseStage } from './helpers/stage'
import { selectDropdown } from './helpers/dropdown'

async function openWorkspace(page: Page) {
  await page.goto('/')
  await expect(page.getByRole('grid', { name: 'Sales pipeline deals' })).toBeVisible()
  await page.evaluate(async () => {
    const response = await fetch('/api/simulation', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ minSaveDelayMs: 20, maxSaveDelayMs: 20, failureRate: 0 }),
    })
    if (!response.ok) throw new Error('Could not configure deterministic saves')
  })
}

async function firstDeal(page: Page) {
  const company = page.locator('.ag-row[row-index="0"] [col-id="company"]')
  await expect(company).toBeVisible()
  const id = await company.locator('xpath=ancestor::*[@row-id][1]').getAttribute('row-id')
  const row = page.locator(`.ag-row[row-id="${id}"]`)
  return { row, company: row.locator('[col-id="company"]') }
}

test('My deals keeps a stage-edited row in company order when all stages match', async ({
  page,
}) => {
  await openWorkspace(page)
  await page.getByRole('button', { name: /^My deals/ }).click()
  const { row, company } = await firstDeal(page)
  const before = await company.locator('xpath=ancestor::*[@row-id][1]').getAttribute('row-index')
  const name = await company.locator('strong').innerText()
  await row.getByTestId('deal-stage').click()
  await chooseStage(page, 'contacted')
  await expect(row.getByTestId('stage-feedback')).toHaveAttribute('data-state', 'succeeded')
  await page.getByRole('button', { name: 'Refresh list', exact: true }).click()
  await expect(company.locator('xpath=ancestor::*[@row-id][1]')).toHaveAttribute(
    'row-index',
    before!,
  )
  await expect(company).toContainText(name)
  await expect(row.getByTestId('deal-stage')).toHaveText('Contacted')
  await expect(page.getByTestId('matching-count')).toHaveText('2,500 matching deals')
  await expect(page.locator('footer')).toContainText('Sorted by Company ascending')
})

test('Refresh list removes a locally edited deal that no longer matches the stage filter', async ({
  page,
}) => {
  await openWorkspace(page)
  await page.getByRole('button', { name: /^My deals/ }).click()
  await selectDropdown(page.getByRole('combobox', { name: 'Stage', exact: true }), 'New Lead')
  const initial = Number((await page.getByTestId('matching-count').innerText()).replace(/\D/g, ''))
  const { row } = await firstDeal(page)
  await row.getByTestId('deal-stage').click()
  await chooseStage(page, 'contacted')
  await expect(row.getByTestId('stage-feedback')).toHaveAttribute('data-state', 'succeeded')
  await expect(row.locator('[col-id="company"]')).toContainText('No longer matches filters')
  await page.getByRole('button', { name: 'Refresh list', exact: true }).click()
  await expect(row).toHaveCount(0)
  await expect(page.getByTestId('matching-count')).toHaveText(
    `${new Intl.NumberFormat('en-IN').format(initial - 1)} matching deals`,
  )
})

test('Refresh list moves a locally edited deal under Stage sorting and retains focus on that deal', async ({
  page,
}) => {
  await openWorkspace(page)
  await page.getByRole('button', { name: /^My deals/ }).click()
  await page.getByRole('columnheader', { name: 'Stage', exact: true }).click()
  const { row, company } = await firstDeal(page)
  const before = await company.locator('xpath=ancestor::*[@row-id][1]').getAttribute('row-index')
  await row.getByTestId('deal-stage').click()
  await chooseStage(page, 'won')
  await expect(row.getByTestId('stage-feedback')).toHaveAttribute('data-state', 'succeeded')
  await expect(company.locator('xpath=ancestor::*[@row-id][1]')).toHaveAttribute(
    'row-index',
    before!,
  )
  await page.getByRole('button', { name: 'Refresh list', exact: true }).click()
  await expect(company.locator('xpath=ancestor::*[@row-id][1]')).not.toHaveAttribute(
    'row-index',
    before!,
  )
  await expect(row.locator('[col-id="stage"]')).toBeFocused()
  await expect(row.locator('[col-id="stage"]')).toBeInViewport()
  await expect(row.getByTestId('deal-stage')).toHaveText('Won')
  await expect(page.locator('footer')).toContainText('Sorted by Stage ascending')
})

test('Refresh list removes a closed deal from Needs attention after its local save', async ({
  page,
}) => {
  await openWorkspace(page)
  await page.getByRole('button', { name: /^Needs attention/ }).click()
  const { row } = await firstDeal(page)
  await row.getByTestId('deal-stage').click()
  await chooseStage(page, 'won')
  await expect(row.getByTestId('stage-feedback')).toHaveAttribute('data-state', 'succeeded')
  await page.getByRole('button', { name: 'Refresh list', exact: true }).click()
  await expect(row).toHaveCount(0)
})
