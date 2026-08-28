import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-splits.json' })

async function goToSplit(page: Page, position: number): Promise<void> {
  await page.keyboard.press('g')
  await page.keyboard.press(String(position))
}

async function openSplitRules(page: Page): Promise<void> {
  await page.getByTestId('account-menu').getByRole('button').first().click()
  await page.getByTestId('account-split-rules').click()
  await expect(page.getByTestId('split-rules')).toBeVisible()
}

async function emitFocusThread(app: ElectronApplication, threadId: string): Promise<void> {
  await app.evaluate(({ ipcMain }, { channel, id }) => ipcMain.emit(channel, {}, id), {
    channel: TEST_CHANNELS.focusThread,
    id: threadId
  })
}

function spread(values: number[]): number {
  return Math.max(...values) - Math.min(...values)
}

test('classifies once, navigates locally, and restores each split selection', async ({ page }, testInfo) => {
  const strip = page.getByTestId('split-strip')
  const tabs = page.getByTestId('split-tab')
  const rows = page.getByTestId('thread-row')
  await expect(strip).toBeVisible()
  await expect(tabs).toHaveCount(5)
  await expect(tabs).toHaveText([/Calendar1/, /GitHub1/, /Newsletters1/, /Important1/, /Other1/])

  await expect(page.locator('[data-testid="split-tab"][data-split-id="base:important"]')).toHaveAttribute(
    'data-active',
    'true'
  )
  await expect(rows).toHaveCount(1)
  await expect(rows).toContainText('Board memo needs approval')

  await page.locator('[data-testid="split-tab"][data-split-id="fallback:other"]').click()
  await expect(rows).toHaveCount(2)
  await page.keyboard.press('j')
  await expect(rows.filter({ hasText: 'Weekend walk' })).toHaveAttribute('data-selected', 'true')

  await page.locator('[data-testid="split-tab"][data-split-id="preset:calendar"]').click()
  await expect(rows).toHaveCount(2)
  await expect(rows).toContainText(['Planning check-in tomorrow', 'Quarterly planning invite'])
  await page.keyboard.press('j')
  await expect(rows.filter({ hasText: 'Quarterly planning invite' })).toHaveAttribute('data-selected', 'true')

  await page.locator('[data-testid="split-tab"][data-split-id="fallback:other"]').click()
  await expect(rows).toContainText(['Dinner Friday?', 'Weekend walk'])
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-view')).toContainText('Weekend walk')
  await page.keyboard.press('Escape')
  await page.keyboard.press('ArrowLeft')
  await expect(rows).toContainText('Board memo needs approval')
  await page.keyboard.press('ArrowRight')
  await expect(rows).toContainText(['Dinner Friday?', 'Weekend walk'])
  await page.keyboard.press('Shift+Tab')
  await expect(rows).toContainText('Board memo needs approval')
  await page.keyboard.press('Tab')
  await expect(rows).toContainText(['Dinner Friday?', 'Weekend walk'])
  await page.keyboard.press('Tab')
  await expect(rows).toContainText(['Planning check-in tomorrow', 'Quarterly planning invite'])
  await page.keyboard.press('Shift+Tab')
  await expect(rows).toContainText(['Dinner Friday?', 'Weekend walk'])

  await goToSplit(page, 2)
  await expect(rows).toHaveCount(1)
  await expect(rows).toContainText('Review requested on PR #87')
  await goToSplit(page, 3)
  await expect(rows).toHaveCount(2)
  await expect(rows).toContainText(['The systems issue', 'A special offer for members'])
  await expect(rows.filter({ hasText: 'Review requested on PR #87' })).toHaveCount(0)

  const artifactDirectory = join(__dirname, '.artifacts')
  mkdirSync(artifactDirectory, { recursive: true })
  const inboxPath = join(artifactDirectory, 'split-inbox.png')
  await page.screenshot({ path: inboxPath })
  await testInfo.attach('split-inbox', { path: inboxPath, contentType: 'image/png' })

  await rows.first().click()
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await expect(page.getByTestId('conversation-position')).toHaveText('1 of 2')
  await expect(strip).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(strip).toBeVisible()
  const allMail = page.getByTestId('sidebar-mailbox').filter({ hasText: 'All Mail' })
  await allMail.click()
  await allMail.focus()
  await expect(allMail).toBeFocused()
  await expect(page.getByTestId('view-title')).toHaveText('All Mail')
  await expect(strip).toHaveCount(0)
  await page.keyboard.press('Tab')
  await expect(page.getByTestId('view-title')).toHaveText('Inbox')
  await expect(strip).toBeVisible()

  await page.evaluate(async () => {
    for (let index = 1; index <= 4; index++) {
      await window.attn.splits.save({
        name: `Custom ${index}`,
        operator: 'any',
        conditions: [{ type: 'senderDomain', value: `custom-${index}.example` }],
        notify: false
      })
    }
  })
  await expect(tabs).toHaveCount(8)
  await page.getByTestId('split-strip-overflow').click()
  await expect(page.getByTestId('split-overflow-menu')).toBeVisible()
  await expect(page.getByTestId('split-overflow-tab')).toHaveCount(1)
  await expect(page.getByTestId('split-overflow-tab')).toContainText('Other')
  await page.getByTestId('split-overflow-tab').click()
  await expect(page.locator('[data-testid="split-tab"][data-split-id="fallback:other"]')).toHaveAttribute(
    'data-active',
    'true'
  )

  await page.keyboard.press('ControlOrMeta+K')
  await page.getByTestId('command-palette-input').fill('Go to:')
  await expect(page.locator('[data-command-id^="split.goto:"]')).toHaveCount(9)
})

test('moves between Important and Other by changing Gmail importance', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  const boardMemo = rows.filter({ hasText: 'Board memo needs approval' })
  await expect(boardMemo).toBeVisible()

  await page.getByTestId('thread-list').focus()
  await page.keyboard.press('v')
  await expect(page.getByTestId('move-picker')).toBeVisible()
  await expect(page.getByTestId('move-important')).toBeDisabled()
  await page.getByTestId('move-other').click()
  await expect(boardMemo).toHaveCount(0)
  await expect(page.getByTestId('pending-count')).toContainText('1 pending')

  await page.locator('[data-testid="split-tab"][data-split-id="fallback:other"]').click()
  await expect(boardMemo).toBeVisible()
  await expect(rows).toHaveCount(3)
  await expect(boardMemo).toHaveAttribute('data-selected', 'true')
  await page.getByTestId('thread-list').focus()
  await page.keyboard.press('v')
  await expect(page.getByTestId('move-other')).toBeDisabled()
  await page.getByTestId('move-important').click()
  await expect(boardMemo).toHaveCount(0)
  await expect(page.getByTestId('pending-count')).toContainText('2 pending')

  await page.locator('[data-testid="split-tab"][data-split-id="base:important"]').click()
  await expect(boardMemo).toBeVisible()
})

test('edits, reorders, deletes, persists, and explicitly restores a starter preset', async ({
  boot,
  page
}, testInfo) => {
  await openSplitRules(page)
  await expect(page.getByTestId('split-rule')).toHaveCount(5)

  const artifactDirectory = join(__dirname, '.artifacts')
  mkdirSync(artifactDirectory, { recursive: true })
  const rulesPath = join(artifactDirectory, 'split-rules.png')
  await page.screenshot({ path: rulesPath })
  await testInfo.attach('split-rules', { path: rulesPath, contentType: 'image/png' })
  const alignedColumns = await page.getByTestId('split-rule').evaluateAll((rows) =>
    rows.map((row) => ({
      handle: row.querySelector('[data-testid="split-rule-drag-handle"]')?.getBoundingClientRect().x ?? -1,
      summary: row.querySelector('[data-testid="split-rule-summary"]')?.getBoundingClientRect().x ?? -1,
      notify: row.querySelector('input[type="checkbox"]')?.getBoundingClientRect().x ?? -1,
      action: row.querySelector('[data-testid="split-rule-action"]')?.getBoundingClientRect().x ?? -1
    }))
  )
  const handles = alignedColumns.map(({ handle }) => handle).filter((handle) => handle >= 0)
  expect(spread(handles)).toBeLessThan(1)
  expect(Math.max(...handles)).toBeLessThan(Math.min(...alignedColumns.map(({ summary }) => summary)))
  expect(spread(alignedColumns.map(({ notify }) => notify))).toBeLessThan(1)
  expect(spread(alignedColumns.map(({ action }) => action))).toBeLessThan(1)

  await page.getByRole('button', { name: 'New split' }).click()
  await page.getByTestId('split-rule-name').fill('Personal')
  await page.getByLabel('Condition 1 type').selectOption('senderAddress')
  await page.getByLabel('Condition 1 value').fill('sam@example.com')
  await page.getByRole('button', { name: 'Save split' }).click()
  await expect(page.getByTestId('split-rule')).toHaveCount(6)
  await expect(page.getByTestId('split-rule').filter({ hasText: 'Personal' })).toContainText('1 total')

  const github = page.locator('[data-testid="split-rule"][data-split-id="preset:github"]')
  await github.getByRole('button', { name: 'Edit' }).click()
  await page.getByTestId('split-rule-name').fill('Code reviews')
  await page.getByRole('button', { name: 'Save split' }).click()
  await expect(github).toContainText('Code reviews')

  const newsletters = page.locator('[data-testid="split-rule"][data-split-id="preset:newsletters"]')
  const newslettersHandle = newsletters.getByTestId('split-rule-drag-handle')
  const handleBox = await newslettersHandle.boundingBox()
  const newslettersBox = await newsletters.boundingBox()
  const githubBox = await github.boundingBox()
  if (!handleBox || !newslettersBox || !githubBox) throw new Error('Split drag geometry is unavailable')
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
  await page.mouse.down()
  const pointerY = githubBox.y + githubBox.height / 2
  await page.mouse.move(handleBox.x + handleBox.width / 2, pointerY, { steps: 8 })
  const draggedNewsletter = page.locator(
    '[data-testid="split-rule"][data-split-id="preset:newsletters"][data-dragging="true"]'
  )
  const dragOverlay = page.locator(
    '[data-testid="split-rule-drag-overlay"][data-split-id="preset:newsletters"]'
  )
  await expect(draggedNewsletter).toHaveCount(1)
  await expect(dragOverlay).toBeVisible()
  const overlayBox = await dragOverlay.boundingBox()
  expect(overlayBox?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(pointerY)
  expect((overlayBox?.y ?? 0) + (overlayBox?.height ?? 0)).toBeGreaterThan(pointerY)
  await expect
    .poll(async () => Math.abs(((await github.boundingBox())?.y ?? 0) - newslettersBox.y))
    .toBeLessThan(2)
  const dragPath = join(artifactDirectory, 'split-rules-drag.png')
  await page.screenshot({ path: dragPath })
  await testInfo.attach('split-rules-drag', { path: dragPath, contentType: 'image/png' })
  await page.mouse.up()
  await expect(draggedNewsletter).toHaveCount(0)
  await expect(dragOverlay).toHaveCount(0)
  await expect(newsletters).toHaveCount(1)
  // dnd-kit intentionally suppresses click events for 50 ms after a pointer drag.
  await page.waitForTimeout(60)
  await expect(page.getByTestId('split-rule').nth(1)).toHaveAttribute('data-split-id', 'preset:newsletters')
  await newslettersHandle.press('ArrowDown')
  await expect(page.getByTestId('split-rule').nth(2)).toHaveAttribute('data-split-id', 'preset:newsletters')
  await expect(newslettersHandle).toBeEnabled()
  await newslettersHandle.press('ArrowUp')
  await expect(page.getByTestId('split-rule').nth(1)).toHaveAttribute('data-split-id', 'preset:newsletters')

  await github.getByTestId('split-rule-delete').click()
  await expect(github).toHaveCount(0)
  await expect(page.getByTestId('split-rule-restore').filter({ hasText: 'GitHub' })).toBeVisible()
  await page.getByRole('button', { name: 'Close split rules' }).click()
  await expect(page.locator('[data-testid="split-tab"][data-split-id="preset:github"]')).toHaveCount(0)

  const relaunched = await boot.relaunch()
  const relaunchedPage = relaunched.page
  await expect(relaunchedPage.getByTestId('split-tab')).toHaveCount(5)
  await expect(
    relaunchedPage.locator('[data-testid="split-tab"][data-split-id="preset:github"]')
  ).toHaveCount(0)
  await openSplitRules(relaunchedPage)
  const restore = relaunchedPage.getByTestId('split-rule-restore').filter({ hasText: 'GitHub' })
  await expect(restore).toBeVisible()
  await restore.click()
  await expect(
    relaunchedPage.locator('[data-testid="split-rule"][data-split-id="preset:github"]')
  ).toContainText('GitHub')
  await relaunchedPage.getByRole('button', { name: 'Close split rules' }).click()
  await expect(
    relaunchedPage.locator('[data-testid="split-tab"][data-split-id="preset:github"]')
  ).toContainText('GitHub')
})

test('notification focus owns selection over a queued split restore', async ({ app, page }) => {
  const calendar = page.locator('[data-testid="split-tab"][data-split-id="preset:calendar"]')
  const important = page.locator('[data-testid="split-tab"][data-split-id="base:important"]')
  const rows = page.getByTestId('thread-row')

  await calendar.click()
  await expect(rows).toHaveCount(2)
  await page.keyboard.press('j')
  await expect(rows.filter({ hasText: 'Quarterly planning invite' })).toHaveAttribute('data-selected', 'true')

  await important.click()
  await expect(rows).toContainText('Board memo needs approval')
  await page.evaluate(() => {
    const tab = document.querySelector<HTMLElement>(
      '[data-testid="split-tab"][data-split-id="preset:calendar"]'
    )
    if (!tab) throw new Error('Calendar split tab is missing')
    tab.click()
  })
  await emitFocusThread(app, 't-calendar-sender')

  await expect(page.getByTestId('conversation-subject')).toHaveText('Planning check-in tomorrow')
  await expect(rows.filter({ hasText: 'Planning check-in tomorrow' })).toHaveAttribute(
    'data-selected',
    'true'
  )
})
