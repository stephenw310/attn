import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from '@playwright/test'
import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-inbox.json' })

async function openMove(page: Page): Promise<void> {
  await page.keyboard.press('v')
  await expect(page.getByTestId('move-picker')).toBeVisible()
  await expect(page.getByTestId('move-search')).toBeFocused()
}

async function chooseMoveLabel(page: Page, label: string): Promise<void> {
  const input = page.getByTestId('move-search')
  await input.fill(label)
  await input.press('Enter')
  await expect(page.getByTestId('move-picker')).toHaveCount(0)
}

async function goTo(page: Page, chordKey: string): Promise<void> {
  await page.keyboard.press('g')
  await page.keyboard.press(chordKey)
}

async function expectMovePaletteCount(page: Page, count: number): Promise<void> {
  await page.keyboard.press('ControlOrMeta+K')
  await page.getByTestId('command-palette-input').fill('Move')
  await expect(page.locator('[data-command-id="triage.move"]')).toHaveCount(count)
  await page.keyboard.press('Escape')
}

test('moves from Inbox to a label, auto-advances, and moves that label to Done', async ({
  page
}, testInfo) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await expect(rows.first()).toContainText('Q3 roadmap review')

  await openMove(page)
  await expect(page.getByTestId('move-done')).toHaveText(/Done/)
  await expect(page.getByTestId('move-option')).toHaveCount(12)

  const artifactDirectory = join(__dirname, '.artifacts')
  mkdirSync(artifactDirectory, { recursive: true })
  const path = join(artifactDirectory, 'move-picker.png')
  await page.screenshot({ path })
  await testInfo.attach('move-picker', { path, contentType: 'image/png' })

  await page.getByTestId('move-search').fill('v')
  await expect(page.getByTestId('move-picker')).toBeVisible()
  await expect(rows).toHaveCount(8)
  await page.getByTestId('move-search').fill('projects')
  await page.getByTestId('move-search').press('Enter')
  await expect(page.getByTestId('move-picker')).toHaveCount(0)
  await expect(rows).toHaveCount(7)
  await expect(rows.first()).toContainText('Your receipt')
  await expect(rows.first()).toHaveAttribute('data-selected', 'true')
  await expect(page.getByTestId('pending-count')).toContainText('1 pending')

  await page.getByTestId('sidebar-label').filter({ hasText: 'projects' }).click()
  const roadmap = rows.filter({ hasText: 'Q3 roadmap review' })
  await expect(roadmap).toHaveCount(1)
  await expect(roadmap).toHaveAttribute('data-selected', 'true')
  await page.getByTestId('thread-list').focus()
  await openMove(page)
  await expect(page.locator('[data-label-id="Label_2"]')).toHaveCount(0)
  await page.getByTestId('move-done').click()
  await expect(roadmap).toHaveCount(0)
  await expect(page.getByTestId('pending-count')).toContainText('2 pending')
})

test('moves a frozen bulk selection and restores every prior label with one undo', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await rows.nth(2).click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('selection-count')).toHaveText('3 selected')

  await openMove(page)
  await chooseMoveLabel(page, 'travel')
  await expect(rows).toHaveCount(5)
  await expect(page.getByTestId('selection-count')).toHaveCount(0)
  await expect(page.getByTestId('pending-count')).toContainText('3 pending')

  await page.keyboard.press('z')
  await expect(rows).toHaveCount(8)
  await expect(page.getByTestId('pending-count')).toContainText('6 pending')
  await expect(rows.filter({ hasText: 'Q3 roadmap review' }).getByTestId('label-chip')).toHaveCount(0)
  await expect(rows.filter({ hasText: 'Your receipt' }).getByTestId('label-chip')).toHaveText('receipts')
  await expect(rows.filter({ hasText: 'Design notes' }).getByTestId('label-chip')).toHaveText('projects')
  await expect(rows.getByTestId('label-chip').filter({ hasText: 'travel' })).toHaveCount(0)
})

test('keeps All Mail membership, status, and unrelated labels after Move', async ({ page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await page.getByTestId('thread-list').focus()
  await goTo(page, 'a')
  await expect(page.getByTestId('view-title')).toHaveText('All Mail')
  const design = page.locator('[data-testid="thread-row"][data-thread-id="t-design"]')
  await expect(design).toBeVisible()
  await page.keyboard.press('j')
  await page.keyboard.press('j')
  await expect(design).toHaveAttribute('data-selected', 'true')
  await openMove(page)
  await chooseMoveLabel(page, 'receipts')

  await expect(design).toBeVisible()
  await expect(design).toHaveAttribute('data-selected', 'true')
  await expect(design).toHaveAttribute('data-unread', 'true')
  await expect(design).toHaveAttribute('data-starred', 'true')
  await expect(design.getByTestId('label-chip')).toHaveCount(2)
  await expect(design.getByTestId('label-chip').filter({ hasText: 'projects' })).toBeVisible()
  await expect(design.getByTestId('label-chip').filter({ hasText: 'receipts' })).toBeVisible()
  await expect(page.getByTestId('pending-count')).toContainText('1 pending')
})

test('moves through Spam, Trash, and Inbox with one Gmail label delta per move', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  const roadmap = page.locator('[data-testid="thread-row"][data-thread-id="t-roadmap"]')
  await expect(roadmap).toBeVisible()

  await page.getByTestId('thread-list').focus()
  await openMove(page)
  await page.getByTestId('move-spam').click()
  await expect(roadmap).toHaveCount(0)
  await expect(page.getByTestId('pending-count')).toContainText('1 pending')

  await goTo(page, 'p')
  await expect(page.getByTestId('view-title')).toHaveText('Spam')
  await expect(roadmap).toBeVisible()
  await expect(rows).toHaveCount(1)
  await page.getByTestId('thread-list').focus()
  await openMove(page)
  await expect(page.getByTestId('move-spam')).toBeDisabled()
  await page.getByTestId('move-trash').click()
  await expect(roadmap).toHaveCount(0)

  await goTo(page, 'r')
  await expect(page.getByTestId('view-title')).toHaveText('Trash')
  await expect(roadmap).toBeVisible()
  await page.getByTestId('thread-list').focus()
  await openMove(page)
  await expect(page.getByTestId('move-trash')).toBeDisabled()
  await page.getByTestId('move-inbox').click()
  await expect(roadmap).toHaveCount(0)

  await goTo(page, 'i')
  await expect(roadmap).toBeVisible()
  await expect(page.getByTestId('pending-count')).toContainText('3 pending')

  await page.keyboard.press('z')
  await expect(roadmap).toHaveCount(0)
  await goTo(page, 'r')
  await expect(roadmap).toBeVisible()
})

test('uses the same exclusive Spam and Trash transitions for direct shortcuts', async ({ page }) => {
  const roadmap = page.locator('[data-testid="thread-row"][data-thread-id="t-roadmap"]')
  await expect(roadmap).toBeVisible()

  await page.getByTestId('thread-list').focus()
  await page.keyboard.press('#')
  await expect(roadmap).toHaveCount(0)

  await goTo(page, 'r')
  await expect(roadmap).toBeVisible()
  await page.getByTestId('thread-list').focus()
  await page.keyboard.press('!')
  await expect(roadmap).toHaveCount(0)

  await goTo(page, 'p')
  await expect(roadmap).toBeVisible()
  await page.getByTestId('thread-list').focus()
  await page.keyboard.press('#')
  await expect(roadmap).toHaveCount(0)
  await expect(page.getByTestId('pending-count')).toContainText('3 pending')

  await page.keyboard.press('z')
  await expect(roadmap).toHaveCount(0)
  await goTo(page, 'p')
  await expect(roadmap).toBeVisible()
})

test('re-evaluates an active Inbox search after the optimistic Move', async ({ page }) => {
  await page.getByTestId('thread-list').focus()
  await page.keyboard.press('/')
  await page.getByTestId('search-input').fill('in:inbox')
  await page.getByTestId('search-input').press('Enter')
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  const roadmap = page.locator('[data-testid="thread-row"][data-thread-id="t-roadmap"]')

  await page.getByTestId('thread-list').focus()
  await openMove(page)
  await chooseMoveLabel(page, 'travel')
  await expect(roadmap).toHaveAttribute('data-exiting', 'true')
  await expect(rows).toHaveCount(7)
  await expect(page.getByTestId('search-input')).toHaveValue('in:inbox')
})

test('cancels a snooze reached through a user label and restores its exact due time', async ({ page }) => {
  const receipt = page.locator('[data-testid="thread-row"][data-thread-id="t-receipt"]')
  await receipt.click()
  await page.keyboard.press('h')
  await page.getByTestId('snooze-preset-tomorrow').click()

  await goTo(page, 'h')
  const snoozedReceipt = page.locator('[data-testid="thread-row"][data-thread-id="t-receipt"]')
  await expect(snoozedReceipt).toBeVisible()
  const originalDue = await snoozedReceipt.getByTestId('chip-snooze-due').textContent()

  await page.getByTestId('sidebar-label').filter({ hasText: 'receipts' }).click()
  await expect(receipt).toBeVisible()
  await receipt.click()
  await openMove(page)
  await chooseMoveLabel(page, 'projects')
  await expect(receipt).toHaveCount(0)

  await goTo(page, 'h')
  await expect(snoozedReceipt).toHaveCount(0)
  await page.keyboard.press('z')
  await expect(snoozedReceipt).toBeVisible()
  await expect(snoozedReceipt.getByTestId('chip-snooze-due')).toHaveText(originalDue ?? '')
})

test('offers Move in mailboxes and omits it from non-message destinations', async ({ page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await expect(page.getByTestId('footer-shortcut-move')).toContainText('Vmove')
  await expectMovePaletteCount(page, 1)

  for (const shortcut of ['d', 'h', 'o']) {
    await goTo(page, shortcut)
    await expect(page.getByTestId('footer-shortcut-move')).toHaveCount(0)
    await expectMovePaletteCount(page, 0)
  }

  await goTo(page, 'r')
  await expect(page.getByTestId('footer-shortcut-move')).toContainText('Vmove')
  await expectMovePaletteCount(page, 1)

  await goTo(page, 'i')
  await page.keyboard.press('/')
  await page.getByTestId('search-input').fill('in:trash')
  await page.getByTestId('search-input').press('Enter')
  await expect(page.getByTestId('footer-shortcut-move')).toContainText('Vmove')
  await expectMovePaletteCount(page, 1)
})
