import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { expect, test } from './electron'
import { emitFocusThread } from './seams'

test.use({ seed: 'fixtures/seed-splits.json' })

async function openSplitRules(page: Page): Promise<void> {
  await page.getByTestId('split-rules-settings').click()
  await expect(page.getByTestId('split-rules')).toBeVisible()
}

async function updateMessageBody(
  app: ElectronApplication,
  messageId: string,
  bodyText: string
): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, { channel, id, body }) =>
      new Promise<void>((resolve, reject) => {
        ipcMain.emit(channel, {}, id, body, (error?: string) => {
          if (error) reject(new Error(error))
          else resolve()
        })
      }),
    { channel: TEST_CHANNELS.updateMessageBody, id: messageId, body: bodyText }
  )
}

function spread(values: number[]): number {
  return Math.max(...values) - Math.min(...values)
}

test('classifies once, navigates locally, and restores each split selection', async ({
  app,
  page
}, testInfo) => {
  const strip = page.getByTestId('split-strip')
  const tabs = page.getByTestId('split-tab')
  const rows = page.getByTestId('thread-row')
  await expect(strip).toBeVisible()
  await expect(tabs).toHaveCount(5)
  await expect(tabs).toHaveText([/Calendar1/, /GitHub1/, /Newsletters1/, /Important1/, /Other1/])
  // Rules have one visible home in the Inbox header. The ellipsis appears
  // only when there are genuinely hidden splits to navigate to.
  await expect(page.getByTestId('split-rules-settings')).toHaveAttribute('title', 'Manage Inbox splits')
  await expect(page.getByTestId('split-strip-overflow')).toHaveCount(0)

  await expect(page.locator('[data-testid="split-tab"][data-split-id="base:important"]')).toHaveAttribute(
    'data-active',
    'true'
  )
  await expect(rows).toHaveCount(1)
  await expect(rows).toContainText('Board memo needs approval')

  await page.evaluate(() => {
    const appWindow = window as typeof window & {
      splitEmptyObserver?: MutationObserver
      splitEmptyPaints?: number
    }
    const threadList = document.querySelector('[data-testid="thread-list"]')
    if (!threadList) throw new Error('Thread list is unavailable')
    appWindow.splitEmptyPaints = 0
    appWindow.splitEmptyObserver = new MutationObserver(() => {
      if (threadList.textContent?.includes('Inbox empty')) appWindow.splitEmptyPaints = 1
    })
    appWindow.splitEmptyObserver.observe(threadList, {
      childList: true,
      subtree: true,
      characterData: true
    })
  })

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

  await page.keyboard.press('Tab')
  await page.keyboard.press('Tab')
  await expect(rows).toHaveCount(1)
  await expect(rows).toContainText('Review requested on PR #87')
  await page.keyboard.press('Tab')
  await expect(rows).toHaveCount(2)
  await expect(rows).toContainText(['The systems issue', 'A special offer for members'])
  await expect(rows.filter({ hasText: 'Review requested on PR #87' })).toHaveCount(0)
  const splitEmptyPaints = await page.evaluate(() => {
    const appWindow = window as typeof window & {
      splitEmptyObserver?: MutationObserver
      splitEmptyPaints?: number
    }
    appWindow.splitEmptyObserver?.disconnect()
    return appWindow.splitEmptyPaints ?? 0
  })
  expect(splitEmptyPaints).toBe(0)

  const artifactDirectory = join(__dirname, '.artifacts')
  mkdirSync(artifactDirectory, { recursive: true })
  const inboxPath = join(artifactDirectory, 'split-inbox.png')
  await page.screenshot({ path: inboxPath })
  await testInfo.attach('split-inbox', { path: inboxPath, contentType: 'image/png' })

  await page.evaluate(() => {
    const appWindow = window as typeof window & {
      splitTransitionObserver?: MutationObserver
      splitTransitionStates?: string[]
    }
    appWindow.splitTransitionObserver?.disconnect()
    appWindow.splitTransitionStates = []
    const threadList = document.querySelector('[data-testid="thread-list"]')
    if (!threadList) throw new Error('Thread list is unavailable')
    const recordTransientState = (): void => {
      for (const copy of ['Inbox empty', 'Loading conversations…']) {
        if (threadList.textContent?.includes(copy)) appWindow.splitTransitionStates?.push(copy)
      }
    }
    appWindow.splitTransitionObserver = new MutationObserver(recordTransientState)
    appWindow.splitTransitionObserver.observe(threadList, {
      childList: true,
      subtree: true,
      characterData: true
    })
  })
  const mailChanged = page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const off = window.attn.mail.onChanged(() => {
          off()
          resolve()
        })
      })
  )
  await updateMessageBody(app, 'm-calendar-sender', 'A locally refreshed calendar invitation.')
  await mailChanged
  await page.keyboard.press('Shift+Tab')
  await expect(rows).toContainText('Review requested on PR #87')
  const transientStates = await page.evaluate(() => {
    const appWindow = window as typeof window & {
      splitTransitionObserver?: MutationObserver
      splitTransitionStates?: string[]
    }
    appWindow.splitTransitionObserver?.disconnect()
    return appWindow.splitTransitionStates ?? []
  })
  expect(transientStates).toEqual([])
  await page.keyboard.press('Tab')
  await expect(rows).toContainText(['The systems issue', 'A special offer for members'])

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
  const expectManagerBeforeOverflow = async (): Promise<void> => {
    const tabListBox = await page.getByRole('tablist', { name: 'Inbox splits' }).boundingBox()
    const managerBox = await page.getByTestId('split-rules-settings').boundingBox()
    const overflowBox = await page.getByTestId('split-strip-overflow').boundingBox()
    if (!tabListBox || !managerBox || !overflowBox) throw new Error('Split controls are unavailable')
    expect(managerBox.x - (tabListBox.x + tabListBox.width)).toBeGreaterThanOrEqual(0)
    expect(managerBox.x - (tabListBox.x + tabListBox.width)).toBeLessThanOrEqual(12)
    expect(overflowBox.x).toBeGreaterThanOrEqual(managerBox.x + managerBox.width)
  }
  await expectManagerBeforeOverflow()
  await page.getByTestId('split-strip-overflow').click()
  await expect(page.getByTestId('split-overflow-menu')).toBeVisible()
  await expect(page.getByTestId('split-overflow-tab')).toHaveCount(1)
  await expect(page.getByTestId('split-overflow-tab')).toContainText('Other')
  await page.getByTestId('split-overflow-tab').click()
  await expect(page.locator('[data-testid="split-tab"][data-split-id="fallback:other"]')).toHaveAttribute(
    'data-active',
    'true'
  )

  await expectManagerBeforeOverflow()
  const overflowPath = join(artifactDirectory, 'split-inbox-overflow.png')
  await page.screenshot({ path: overflowPath, animations: 'disabled' })
  await testInfo.attach('split-inbox-overflow', { path: overflowPath, contentType: 'image/png' })
  await openSplitRules(page)
  await page.keyboard.press('Escape')

  await page.keyboard.press('ControlOrMeta+K')
  await page.getByTestId('command-palette-input').fill('Go to:')
  await expect(page.locator('[data-command-id^="split.goto:"]')).toHaveCount(9)
})

test('changes Gmail importance without presenting splits as move destinations', async ({
  page
}, testInfo) => {
  const rows = page.getByTestId('thread-row')
  const boardMemo = rows.filter({ hasText: 'Board memo needs approval' })
  await expect(boardMemo).toBeVisible()

  await page.getByTestId('thread-list').focus()
  await page.keyboard.press('v')
  await expect(page.getByTestId('move-picker')).toBeVisible()
  await expect(page.getByTestId('move-section-importance')).toHaveText('Importance')
  await expect(page.getByTestId('move-mark-important')).toHaveCount(0)
  await expect(page.getByTestId('move-mark-not-important')).toHaveText(/Mark as not important/)
  const artifactDirectory = join(__dirname, '.artifacts')
  mkdirSync(artifactDirectory, { recursive: true })
  const pickerPath = join(artifactDirectory, 'move-picker.png')
  await page.screenshot({ path: pickerPath })
  await testInfo.attach('move-picker', { path: pickerPath, contentType: 'image/png' })
  await page.getByTestId('move-mark-not-important').click()
  await expect(boardMemo).toHaveCount(0)
  await expect(page.getByTestId('pending-count')).toContainText('1 pending')

  await page.locator('[data-testid="split-tab"][data-split-id="fallback:other"]').click()
  await expect(boardMemo).toBeVisible()
  await expect(rows).toHaveCount(3)
  await expect(boardMemo).toHaveAttribute('data-selected', 'true')
  await page.getByTestId('thread-list').focus()
  await page.keyboard.press('v')
  await expect(page.getByTestId('move-mark-not-important')).toHaveCount(0)
  await expect(page.getByTestId('move-mark-important')).toHaveText(/Mark as important/)
  await page.getByTestId('move-mark-important').click()
  await expect(boardMemo).toHaveCount(0)
  await expect(page.getByTestId('pending-count')).toContainText('2 pending')

  await page.locator('[data-testid="split-tab"][data-split-id="base:important"]').click()
  await expect(boardMemo).toBeVisible()
})

test('edits, reorders, deletes, persists, and explicitly restores a starter preset', async ({
  boot,
  page
}, testInfo) => {
  // Pointer drag + two screenshots + a full relaunch put this test right at
  // the 30s budget under software rendering — it times out mid-restore there
  // on unmodified main (verified 2026-08-28). Triple the budget; fast machines
  // finish long before it matters.
  testInfo.slow()
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
  const conditionValue = page.getByLabel('Condition 1 value')
  await conditionValue.pressSequentially('sam@example.com')
  await expect(conditionValue).toBeFocused()
  await expect(conditionValue).toHaveValue('sam@example.com')
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

for (const theme of ['dark', 'light'] as const) {
  test(`split header stays fixed across selection and unread changes in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await expect(page.locator('html')).toHaveAttribute('data-theme-appearance', theme)
    await expect(page.getByTestId('split-tab')).toHaveCount(5)
    await page.evaluate(() => document.fonts.ready)
    const tabs = page.getByTestId('split-tab')
    const manager = page.getByTestId('split-rules-settings')
    const geometry = () =>
      tabs.evaluateAll((elements) =>
        elements.map((element) => {
          const { x, y, width, height } = element.getBoundingClientRect()
          return { x, y, width, height }
        })
      )
    const baseline = await geometry()
    const managerBox = await manager.boundingBox()
    const last = baseline.at(-1)
    if (!managerBox || !last) throw new Error('Split header geometry is unavailable')
    expect(managerBox.x - last.x - last.width).toBeGreaterThanOrEqual(0)
    expect(managerBox.x - last.x - last.width).toBeLessThan(12)
    for (let index = 0; index < 5; index++) {
      await tabs.nth(index).click()
      await expect(tabs.nth(index)).toHaveAttribute('data-active', 'true')
      expect(await geometry()).toEqual(baseline)
    }
    await tabs.first().click()
    await expect(tabs.first().getByTestId('split-unread-count')).toHaveAttribute('data-count', '1')
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('conversation-view')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(tabs.first().getByTestId('split-unread-count')).toHaveCount(0)
    expect(await geometry()).toEqual(baseline)
    await expect(page.getByTestId('queue-readout')).toHaveCount(0)
    const headerBox = await page.getByTestId('mail-header').boundingBox()
    const accountBox = await page.getByTestId('account-menu').boundingBox()
    for (const key of ['p', 'a', 'i']) {
      await page.keyboard.press('g')
      await page.keyboard.press(key)
      expect(await page.getByTestId('mail-header').boundingBox()).toEqual(headerBox)
      expect(await page.getByTestId('account-menu').boundingBox()).toEqual(accountBox)
    }
    mkdirSync(join(__dirname, '.artifacts'), { recursive: true })
    await page.screenshot({
      path: join(__dirname, `.artifacts/split-inbox${theme === 'light' ? '-light' : ''}.png`)
    })
    await manager.click()
    await expect(page.getByTestId('split-rules')).toBeVisible()
  })
}
