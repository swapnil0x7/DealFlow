import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'
import type { Snapshot } from '../src/api/contracts'
import { STAGE_LABELS } from '../src/domain/deal'
import type { Stage } from '../src/domain/deal'
import { selectDropdown } from './helpers/dropdown'
import { chooseStage } from './helpers/stage'
import { openChanges, closeChanges, changesPanel } from './helpers/changes'

async function control(page: Page, path: string, body: object, method = 'POST') {
  await page.evaluate(
    async ({ path, body, method }) => {
      const response = await fetch(`/api/simulation${path}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error('Simulation control failed')
    },
    { path, body, method },
  )
}
async function setup(page: Page, delay = 0) {
  await page.goto('/')
  await expect(page.getByRole('grid', { name: 'Sales pipeline deals' })).toBeVisible()
  await control(
    page,
    '',
    { minSaveDelayMs: delay, maxSaveDelayMs: delay, failureRate: 0, changeDeliveryPaused: true },
    'PATCH',
  )
  const snapshot = await page.evaluate(
    async () => (await (await fetch('/api/deals')).json()) as Snapshot,
  )
  const record = snapshot.deals.at(-1)!
  await page.getByRole('searchbox').fill(record.companyName)
  await expect(page.getByTestId('matching-count')).toContainText('1 matching deals')
  return {
    record,
    sessionId: snapshot.sessionId,
    row: page.locator(`.ag-row[row-id="${record.id}"]`),
  }
}
async function edit(page: Page, row: Locator, stage: Stage) {
  const cell = row.locator('[col-id="stage"]')
  await cell.focus()
  await page.keyboard.press('Enter')
  await chooseStage(page, stage)
  await expect(cell.getByRole('combobox')).toHaveCount(0)
}
async function remoteMove(
  page: Page,
  sessionId: string,
  dealId: string,
  version: number,
  stage: Stage,
) {
  await page.evaluate(
    async ({ sessionId, dealId, version, stage }) => {
      const response = await fetch(`/api/deals/${dealId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-DealDesk-Session': sessionId },
        body: JSON.stringify({
          expectedVersion: version,
          stage,
          mutationId: crypto.randomUUID(),
          actorId: 'owner-2',
        }),
      })
      if ((await response.json()).status !== 'succeeded')
        throw new Error('Teammate scenario failed')
    },
    { sessionId, dealId, version, stage },
  )
}
const feedback = (row: Locator) => row.getByTestId('stage-feedback')
const results = (page: Page) => changesPanel(page).getByTestId('operation-result')

test('a mismatched successful receipt remains recoverable from its row without resending the save', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = window.fetch.bind(window)
    let changed = false
    window.fetch = async (input, init) => {
      const response = await original(input, init)
      const path = new URL(input instanceof Request ? input.url : String(input), location.href)
        .pathname
      if (!changed && init?.method === 'PATCH' && path.startsWith('/api/deals/') && response.ok) {
        changed = true
        const body = await response.json()
        if (body.receipt) body.receipt.mutationId = 'different-command'
        return new Response(JSON.stringify(body), {
          headers: { 'Content-Type': 'application/json' },
        })
      }
      return response
    }
  })
  const { record, row } = await setup(page)
  let writes = 0
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && new URL(request.url()).pathname.startsWith('/api/deals/'))
      writes++
  })
  const target = record.stage === 'contacted' ? 'demo-done' : 'contacted'
  await edit(page, row, target)
  await expect(row.getByTestId('stage-feedback')).toHaveAttribute('data-state', 'unconfirmed')
  await row.getByRole('button', { name: `Check status for ${record.companyName}` }).click()
  await expect(row.getByTestId('stage-feedback')).toHaveAttribute('data-state', 'succeeded')
  await expect(row.getByTestId('deal-stage')).toContainText(STAGE_LABELS[target])
  expect(writes).toBe(1)
  const saved = await page.evaluate(async (id) => {
    const snapshot = (await (await fetch('/api/deals')).json()) as Snapshot
    return snapshot.deals.find((deal) => deal.id === id)
  }, record.id)
  expect(saved?.version).toBe(record.version + 1)
})

test('stage dropdown opens with one click, cancels without saving, and disables during a guarded save', async ({
  page,
}, testInfo) => {
  const commands: Record<string, unknown>[] = []
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && /\/api\/deals\//.test(request.url()))
      commands.push(request.postDataJSON())
  })
  const { row, record } = await setup(page, 900)
  const trigger = row.getByRole('button', { name: /^Change stage for/ })
  await expect(trigger).toHaveAttribute('aria-haspopup', 'listbox')
  const restingBox = await trigger.boundingBox()
  const restingCellBox = await row.locator('[col-id="stage"]').boundingBox()
  expect(restingBox!.y - restingCellBox!.y + restingBox!.height / 2).toBeCloseTo(
    restingCellBox!.height / 2,
    0,
  )
  const restingStyle = await trigger.evaluate((element) => {
    const style = getComputedStyle(element)
    return {
      background: style.backgroundColor,
      color: style.color,
      fontSize: style.fontSize,
      borderRadius: style.borderRadius,
    }
  })
  await trigger.click()
  await expect(page.getByRole('listbox')).toBeVisible()
  const editorTrigger = row.locator('[role="combobox"]')
  expect(await editorTrigger.boundingBox()).toEqual(restingBox)
  expect(
    await editorTrigger.evaluate((element) => {
      const style = getComputedStyle(element)
      return {
        background: style.backgroundColor,
        color: style.color,
        fontSize: style.fontSize,
        borderRadius: style.borderRadius,
      }
    }),
  ).toEqual(restingStyle)
  await page.screenshot({ path: testInfo.outputPath('stage-dropdown-open.png') })
  expect(commands).toHaveLength(0)
  await page.keyboard.press('Escape')
  await expect(trigger).toBeEnabled()
  expect(commands).toHaveLength(0)
  await row
    .locator('[col-id="stage"]')
    .screenshot({ path: testInfo.outputPath('editable-stage.png') })
  await trigger.click()
  await expect(page.getByRole('listbox')).toBeVisible()
  await chooseStage(page, 'contacted')
  await expect(feedback(row)).toHaveAttribute('data-state', 'saving')
  await expect(trigger).toBeDisabled()
  await expect(trigger).toHaveText(STAGE_LABELS[record.stage])
  await expect(page.getByTestId('selection-count')).toContainText('0 selected')
  await expect(feedback(row)).toHaveAttribute('data-state', 'succeeded')
  await expect(trigger).toBeEnabled()
  await expect(trigger).toHaveText('Contacted')
  expect(commands).toHaveLength(1)
  expect(commands[0]).toMatchObject({ expectedVersion: record.version, stage: 'contacted' })
  // Untouched cells are centered; changed cells retain the existing two-line layout.
  const savedBox = await trigger.boundingBox()
  const savedCellBox = await row.locator('[col-id="stage"]').boundingBox()
  expect(savedBox!.width).toBe(restingBox!.width)
  expect(savedBox!.height).toBe(restingBox!.height)
  expect(restingBox!.y - restingCellBox!.y - (savedBox!.y - savedCellBox!.y)).toBe(18)
  await expect(row.locator('[col-id="actions"]')).toHaveCount(0)
  await expect(
    row.locator('[col-id="stage"]').getByRole('button', { name: /^Undo move for/ }),
  ).toBeVisible()
  await trigger.click()
  await expect(page.getByRole('listbox')).toBeVisible()
  expect(await editorTrigger.boundingBox()).toEqual(savedBox)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox')).toHaveCount(0)
  await expect(trigger).toBeEnabled()
  await trigger.click()
  await page.getByRole('option', { name: 'Contacted', exact: true }).click()
  await expect(trigger).toBeEnabled()
  expect(commands).toHaveLength(1)
})

test('keyboard edit retains confirmed values, blocks overlap and supports row-level guarded Undo without opening a panel', async ({
  page,
}) => {
  const { row, record } = await setup(page, 900)
  const cell = row.locator('[col-id="stage"]')
  await cell.focus()
  await page.keyboard.press('F2')
  await expect(cell.getByRole('combobox')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(cell.getByRole('combobox')).toHaveCount(0)
  await edit(page, row, 'contacted')
  await expect(row.getByTestId('deal-stage')).toHaveText(STAGE_LABELS[record.stage])
  await expect(row.locator('[col-id="stage"]')).toContainText('Saving…')
  await expect(row.locator('[col-id="stage"] [title="Moving to Contacted"]')).toBeVisible()
  await page.keyboard.press('F2')
  await expect(cell.getByRole('combobox')).toHaveCount(0)
  await expect(feedback(row)).toHaveAttribute('data-state', 'succeeded')
  await expect(changesPanel(page)).toHaveCount(0)
  await cell.focus()
  await page.keyboard.press('Tab')
  await expect(row.getByRole('button', { name: /^Undo move for/ })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(row.getByRole('button', { name: /^View change details for/ })).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(row.locator('[col-id="activity"]')).toBeFocused()
  await page.keyboard.press('Shift+Tab')
  await expect(cell).toBeFocused()
  await page.keyboard.press('Tab')
  await expect(row.getByRole('button', { name: /^Undo move for/ })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(feedback(row)).toHaveAttribute('data-state', 'succeeded')
  await expect(row.getByTestId('deal-stage')).toHaveText(STAGE_LABELS[record.stage])
  const saved = await page.evaluate(
    async (id) =>
      ((await (await fetch('/api/deals')).json()) as Snapshot).deals.find((deal) => deal.id === id),
    record.id,
  )
  expect(saved).toMatchObject({
    stage: record.stage,
    version: record.version + 2,
    lastActivityAt: record.lastActivityAt,
  })
  await openChanges(page)
  await expect(results(page)).toHaveCount(2)
})

test('row Retry preserves the command identity; history dismissal restores focus', async ({
  page,
}) => {
  const commands: Record<string, unknown>[] = []
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && /\/api\/deals\//.test(request.url()))
      commands.push(request.postDataJSON())
  })
  const { row, record } = await setup(page)
  await control(page, '/faults', { fault: 'save-failure' })
  await edit(page, row, 'contacted')
  await expect(feedback(row)).toHaveAttribute('data-state', 'failed')
  await expect(row.getByTestId('deal-stage')).toHaveText(STAGE_LABELS[record.stage])
  await row.getByRole('button', { name: /^Retry save for/ }).focus()
  await page.keyboard.press('Enter')
  await expect(feedback(row)).toHaveAttribute('data-state', 'succeeded')
  expect(commands).toHaveLength(2)
  expect(commands[1]).toEqual(commands[0])
  await expect(changesPanel(page)).toHaveCount(0)
  const panel = await openChanges(page)
  await panel.getByRole('button', { name: 'Dismiss result', exact: true }).click()
  await expect(results(page)).toHaveCount(0)
  await expect(panel.getByRole('heading', { name: 'Recent changes', exact: true })).toBeFocused()
})

test('resolving the last item in Needs action retains keyboard focus inside the panel', async ({
  page,
}) => {
  const { row } = await setup(page)
  await control(page, '/faults', { fault: 'save-failure' })
  await edit(page, row, 'contacted')
  await expect(feedback(row)).toHaveAttribute('data-state', 'failed')
  await page.getByRole('button', { name: /^Changes/ }).click()
  const panel = changesPanel(page)
  await expect(panel.getByRole('button', { name: 'Needs action', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await panel.getByRole('button', { name: 'Retry save', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(panel.getByTestId('operation-result')).toHaveCount(0)
  await expect(panel.getByRole('heading', { name: 'Recent changes', exact: true })).toBeFocused()
  await panel.getByRole('button', { name: 'All changes', exact: true }).click()
  await expect(results(page).first()).toHaveAttribute('data-state', 'succeeded')
})

test('row conflict review preserves context, closes without resolving, and creates a new guarded replacement', async ({
  page,
}, testInfo) => {
  const commands: Record<string, unknown>[] = []
  page.on('request', (request) => {
    if (
      request.method() === 'PATCH' &&
      /\/api\/deals\//.test(request.url()) &&
      request.postDataJSON().actorId === 'owner-1'
    )
      commands.push(request.postDataJSON())
  })
  const { row, record, sessionId } = await setup(page)
  await remoteMove(page, sessionId, record.id, record.version, 'negotiation')
  await edit(page, row, 'contacted')
  await expect(feedback(row)).toHaveAttribute('data-state', 'conflicted')
  const review = row.getByRole('button', { name: /^Review conflict for/ })
  const before = await page.getByRole('grid').boundingBox()
  await review.click()
  const panel = changesPanel(page)
  await expect(panel).toBeVisible()
  await expect(panel).not.toHaveAttribute('aria-modal', 'true')
  await expect(panel).toContainText(`Negotiation (version ${record.version + 1})`)
  expect(await page.getByRole('grid').boundingBox()).toEqual(before)
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('conflict-panel-desktop.png') })
  await page.keyboard.press('Escape')
  await expect(review).toBeFocused()
  await expect(page.getByRole('button', { name: /^Changes/ })).toContainText('1 need action')
  await page.keyboard.press('Enter')
  await panel.getByRole('button', { name: 'Move to Contacted', exact: true }).click()
  await expect(panel.getByTestId('command-detail')).toHaveAttribute('data-state', 'succeeded')
  expect(commands[0].expectedVersion).toBe(record.version)
  expect(commands[1].expectedVersion).toBe(record.version + 1)
  expect(commands[0].mutationId).not.toBe(commands[1].mutationId)
  await openChanges(page)
  await expect(results(page)).toHaveCount(2)
  await expect(results(page).first()).toHaveAttribute('data-state', 'succeeded')
  await expect(results(page).nth(1)).toHaveAttribute('data-state', 'conflicted')
  await expect(row.getByTestId('deal-stage')).toHaveText('Contacted')
})

test('keeping the latest stage acknowledges a conflict without another save', async ({ page }) => {
  let writes = 0
  page.on('request', (request) => {
    if (request.method() === 'PATCH' && /\/api\/deals\//.test(request.url())) writes++
  })
  const { row, record, sessionId } = await setup(page)
  await remoteMove(page, sessionId, record.id, record.version, 'won')
  await edit(page, row, 'contacted')
  await row.getByRole('button', { name: /^Review conflict for/ }).click()
  const before = writes
  await changesPanel(page).getByRole('button', { name: 'Keep Won', exact: true }).click()
  await expect(changesPanel(page)).toContainText('latest stage kept')
  await expect(page.getByRole('button', { name: /^Changes/ })).not.toContainText('need action')
  await expect(row.getByTestId('deal-stage')).toHaveText('Won')
  expect(writes).toBe(before)
  await openChanges(page)
  await expect(results(page)).toHaveCount(1)
  await expect(results(page).first()).toContainText('latest stage kept')
})

test('another live edit invalidates the open review until the latest stage is explicitly reviewed', async ({
  page,
}) => {
  const { row, record, sessionId } = await setup(page)
  await remoteMove(page, sessionId, record.id, record.version, 'negotiation')
  await edit(page, row, 'contacted')
  await row.getByRole('button', { name: /^Review conflict for/ }).click()
  await control(page, '', { changeDeliveryPaused: false }, 'PATCH')
  await remoteMove(page, sessionId, record.id, record.version + 1, 'won')
  const panel = changesPanel(page)
  await expect(panel.getByText('This deal changed again.', { exact: true })).toBeVisible()
  await expect(panel.getByRole('button', { name: 'Move to Contacted', exact: true })).toBeDisabled()
  await panel.getByRole('button', { name: 'Review latest stage', exact: true }).click()
  await expect(panel).toContainText(`Won (version ${record.version + 2})`)
  await panel.getByRole('button', { name: 'Move to Contacted', exact: true }).click()
  await expect(panel.getByTestId('command-detail')).toHaveAttribute('data-state', 'succeeded')
})

test('lost responses retain unconfirmed state until row-level checking confirms the original write', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const originalFetch = window.fetch.bind(window)
    let interrupted = false
    window.fetch = async (input, init) => {
      if (!interrupted && String(input).includes('/api/operations/')) {
        interrupted = true
        throw new TypeError('Interrupted reconciliation')
      }
      return originalFetch(input, init)
    }
  })
  const { row, record } = await setup(page)
  await control(page, '/faults', { fault: 'lost-response' })
  await edit(page, row, 'contacted')
  await expect(feedback(row)).toHaveAttribute('data-state', 'unconfirmed')
  await expect(row.getByTestId('deal-stage')).toHaveText(STAGE_LABELS[record.stage])
  await row.getByRole('button', { name: /^Check status for/ }).click()
  await expect(feedback(row)).toHaveAttribute('data-state', 'succeeded')
  await expect(changesPanel(page)).toHaveCount(0)
  await openChanges(page)
  await expect(results(page).first()).toContainText('Attempt 1')
})

test('Undo conflicts after an unseen teammate edit and retains the original success in history', async ({
  page,
}) => {
  const { row, record, sessionId } = await setup(page)
  await edit(page, row, 'contacted')
  await expect(feedback(row)).toHaveAttribute('data-state', 'succeeded')
  await remoteMove(page, sessionId, record.id, record.version + 1, 'won')
  await row.getByRole('button', { name: /^Undo move for/ }).click()
  await expect(feedback(row)).toHaveAttribute('data-state', 'conflicted')
  await expect(row.getByTestId('deal-stage')).toHaveText('Won')
  await openChanges(page)
  await expect(results(page).first()).toHaveAttribute('data-state', 'conflicted')
  await expect(results(page).nth(1)).toHaveAttribute('data-state', 'succeeded')
  await expect(
    changesPanel(page).getByRole('button', { name: 'Undo move', exact: true }),
  ).toHaveCount(0)
})

test('history remains accessible after a filtered row disappears and Undo restores the row', async ({
  page,
}) => {
  const { row, record } = await setup(page)
  await selectDropdown(
    page.getByRole('combobox', { name: 'Stage', exact: true }),
    STAGE_LABELS[record.stage],
  )
  await edit(page, row, 'contacted')
  await expect(feedback(row)).toHaveAttribute('data-state', 'succeeded')
  await expect(row).toBeVisible()
  await page.getByRole('button', { name: 'Refresh list', exact: true }).click()
  await expect(page.getByTestId('matching-count')).toContainText('0 matching deals')
  const panel = await openChanges(page)
  await expect(results(page).first()).toHaveAttribute('data-state', 'succeeded')
  await panel.getByRole('button', { name: 'Undo move', exact: true }).click()
  await expect(results(page).first()).toHaveAttribute('data-state', 'succeeded')
  await closeChanges(page)
  await page.getByRole('button', { name: 'Refresh list', exact: true }).click()
  await expect(row.getByTestId('deal-stage')).toHaveText(STAGE_LABELS[record.stage])
})

test('a desktop panel allows work in the grid and becomes a keyboard-contained mobile dialog', async ({
  page,
}, testInfo) => {
  const { row } = await setup(page)
  await control(page, '/faults', { fault: 'save-failure' })
  await edit(page, row, 'contacted')
  await row.getByRole('button', { name: /^View change details for/ }).click()
  const panel = changesPanel(page)
  await page.getByRole('searchbox').click()
  await expect(page.getByRole('searchbox')).toBeFocused()
  await expect(panel).toBeVisible()
  const cell = row.locator('[col-id="stage"]')
  await cell.focus()
  await page.keyboard.press('F2')
  await expect(cell.getByRole('combobox')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(cell.getByRole('combobox')).toHaveCount(0)
  await expect(panel).toBeVisible()
  await panel.getByRole('button', { name: 'Dismiss result', exact: true }).focus()
  await page.keyboard.press('Tab')
  await expect(row.getByRole('button', { name: /^View change details for/ })).toBeFocused()
  await expect(panel).toBeVisible()
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(panel).toHaveAttribute('aria-modal', 'true')
  await expect(panel.getByRole('heading', { name: 'Change details', exact: true })).toBeFocused()
  for (let index = 0; index < 10; index++) {
    await page.keyboard.press('Tab')
    expect(await panel.evaluate((element) => element.contains(document.activeElement))).toBe(true)
  }
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  await page.screenshot({ path: testInfo.outputPath('changes-panel-mobile.png') })
  await page.keyboard.press('Escape')
  await expect(panel).toHaveCount(0)
})

async function bulkMoveOne(page: Page, row: Locator) {
  await row.getByRole('checkbox').check()
  await page.getByRole('button', { name: 'Review bulk move', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Review bulk stage change', exact: true })
  await dialog.getByRole('button', { name: 'Confirm bulk move', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

test('a bulk row retries only its original command and opens a reviewed one-item Undo confirmation', async ({
  page,
}) => {
  const batches: unknown[] = []
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/deals/bulk-move')
      batches.push(request.postDataJSON())
  })
  const { row, record } = await setup(page)
  await control(page, '/faults', { fault: 'save-failure' })
  await bulkMoveOne(page, row)
  await expect(feedback(row)).toHaveAttribute('data-state', 'failed')
  await expect(changesPanel(page)).toHaveCount(0)
  await row.getByRole('button', { name: /^Retry save for/ }).click()
  await expect(feedback(row)).toHaveAttribute('data-state', 'succeeded')
  expect(batches[1]).toEqual(batches[0])
  await row.getByRole('button', { name: /^Undo move for/ }).click()
  const confirmation = page.getByRole('dialog', { name: 'Review bulk Undo', exact: true })
  await expect(confirmation).toBeVisible()
  await expect(
    confirmation.getByText('Selected deals', { exact: true }).locator('+ dd'),
  ).toHaveText('1')
  await page.keyboard.press('Escape')
  await expect(row.getByRole('button', { name: /^Undo move for/ })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: 'Confirm bulk Undo', exact: true }).click()
  await expect(confirmation).toHaveCount(0)
  await expect(row.getByTestId('deal-stage')).toHaveText(STAGE_LABELS[record.stage])
  const panel = await openChanges(page)
  await expect(panel.getByTestId('bulk-operation')).toHaveCount(2)
  const saved = await page.evaluate(
    async (id) =>
      ((await (await fetch('/api/deals')).json()) as Snapshot).deals.find((deal) => deal.id === id),
    record.id,
  )
  expect(saved?.version).toBe(record.version + 2)
})

test('an unconfirmed bulk row checks its own receipt without launching another bulk write', async ({
  page,
}) => {
  let writes = 0
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/deals/bulk-move') writes++
  })
  const { row } = await setup(page)
  await control(page, '/faults', { fault: 'lost-response' })
  await bulkMoveOne(page, row)
  await expect(feedback(row)).toHaveAttribute('data-state', 'unconfirmed')
  await row.getByRole('button', { name: /^Check status for/ }).click()
  await expect(feedback(row)).toHaveAttribute('data-state', 'succeeded')
  await expect(row.getByTestId('deal-stage')).toHaveText('Contacted')
  expect(writes).toBe(1)
})

test('a bulk conflict uses the same review panel and keeping the latest clears only its action badge', async ({
  page,
}) => {
  const { row, record, sessionId } = await setup(page)
  await remoteMove(page, sessionId, record.id, record.version, 'won')
  await bulkMoveOne(page, row)
  await expect(feedback(row)).toHaveAttribute('data-state', 'conflicted')
  await row.getByRole('button', { name: /^Review conflict for/ }).click()
  await changesPanel(page).getByRole('button', { name: 'Keep Won', exact: true }).click()
  await expect(page.getByRole('button', { name: /^Changes/ })).not.toContainText('need action')
  await expect(row.getByTestId('deal-stage')).toHaveText('Won')
  const panel = await openChanges(page)
  await expect(panel.getByTestId('bulk-operation')).toHaveCount(1)
  await expect(
    panel.getByTestId('bulk-counts').locator('[data-state="conflicted"] strong'),
  ).toHaveText('1')
  await expect(panel).toContainText('Latest saved stage kept')
})

test('mobile bulk confirmation remains above the Changes panel and returns focus on cancellation', async ({
  page,
}, testInfo) => {
  const { row, record } = await setup(page)
  await bulkMoveOne(page, row)
  await expect(feedback(row)).toHaveAttribute('data-state', 'succeeded')
  const panel = await openChanges(page)
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(panel).toHaveAttribute('aria-modal', 'true')
  const undo = panel.getByRole('button', { name: 'Review Undo for 1 successes', exact: true })
  await undo.click()
  const confirmation = page.getByRole('dialog', { name: 'Review bulk Undo', exact: true })
  await expect(confirmation).toHaveAttribute('aria-modal', 'true')
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  await page.screenshot({ path: testInfo.outputPath('bulk-confirmation-mobile.png') })
  await page.keyboard.press('Escape')
  await expect(confirmation).toHaveCount(0)
  await expect(undo).toBeFocused()
  await undo.click()
  await confirmation.getByRole('button', { name: 'Confirm bulk Undo', exact: true }).click()
  await expect(confirmation).toHaveCount(0)
  await expect(panel.getByTestId('bulk-operation')).toHaveCount(2)
  const saved = await page.evaluate(
    async (id) =>
      ((await (await fetch('/api/deals')).json()) as Snapshot).deals.find((deal) => deal.id === id),
    record.id,
  )
  expect(saved).toMatchObject({ stage: record.stage, version: record.version + 2 })
})
