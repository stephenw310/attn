import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-inbox.json' })

test('snoozes from the picker, navigates to Snoozed, and undoes', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await page.keyboard.press('h')
  const picker = page.getByTestId('snooze-picker')
  await expect(picker).toBeVisible()
  await expect(picker).toHaveCSS('outline-style', 'none')
  await page.getByTestId('snooze-preset-tomorrow').click()
  await expect(rows).toHaveCount(7)

  await page.keyboard.press('g')
  await page.keyboard.press('h')
  await expect(page.getByTestId('view-title')).toHaveText('Snoozed')
  await expect(rows).toHaveCount(1)
  await expect(page.getByTestId('thread-date-group')).toHaveCount(0)
  await expect(rows.first()).toContainText('Maya Lin')
  await expect(rows.first().getByTestId('chip-snooze-due')).toBeVisible()

  await page.keyboard.press('Shift+G')
  await page.keyboard.press('i')
  await expect(page.getByTestId('view-title')).toHaveText('Snoozed')
  await page.keyboard.press('g')
  await page.keyboard.press('Shift+I')
  await expect(page.getByTestId('view-title')).toHaveText('Snoozed')

  await page.keyboard.press('z')
  await expect(rows).toHaveCount(0)
  await page.keyboard.press('g')
  await page.keyboard.press('i')
  await expect(page.getByTestId('view-title')).toHaveText('Inbox')
  await expect(rows).toHaveCount(8)
})

test('parses custom times without leaking list shortcuts from the input', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await page.keyboard.press('h')
  const input = page.getByTestId('snooze-input')
  await input.fill('in 3 days')
  await expect(page.getByTestId('snooze-resolved')).not.toBeEmpty()
  await input.press('e')
  await expect(rows).toHaveCount(8)
  await input.fill('yesterday 9am')
  await expect(page.getByTestId('snooze-resolved')).toHaveText('Choose a future time')
  await expect(page.getByTestId('snooze-custom-confirm')).toBeDisabled()
})

test('navigates picker options with arrows and unsnoozes back to the inbox', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)

  await page.mouse.move(640, 410)
  await page.keyboard.press('h')
  await expect(page.getByTestId('snooze-preset-later-today')).toHaveAttribute('data-active', 'true')
  await page.keyboard.press('ArrowDown')
  await expect(page.getByTestId('snooze-preset-tonight')).toHaveAttribute('data-active', 'true')
  await page.keyboard.press('Enter')
  await expect(rows).toHaveCount(7)

  await page.keyboard.press('g')
  await page.keyboard.press('h')
  await expect(page.getByTestId('view-title')).toHaveText('Snoozed')
  await expect(rows).toHaveCount(1)

  await page.keyboard.press('h')
  await expect(page.getByTestId('snooze-unsnooze')).toBeVisible()
  await page.keyboard.press('ArrowUp')
  await expect(page.getByTestId('snooze-unsnooze')).toHaveAttribute('data-active', 'true')
  await page.keyboard.press('Enter')
  await expect(rows).toHaveCount(0)

  await page.keyboard.press('g')
  await page.keyboard.press('i')
  await expect(rows).toHaveCount(8)

  await page.keyboard.press('z')
  await expect(rows).toHaveCount(7)
  await page.keyboard.press('g')
  await page.keyboard.press('h')
  await expect(rows).toHaveCount(1)
})

test('undoes reminder changes and archive without losing the original due time', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await page.keyboard.press('h')
  await page.getByTestId('snooze-preset-tomorrow').click()
  await page.keyboard.press('g')
  await page.keyboard.press('h')
  await expect(rows).toHaveCount(1)
  const originalDue = await rows.first().getByTestId('chip-snooze-due').textContent()

  await page.keyboard.press('h')
  // Re-snooze target must never resolve to the same instant as 'tomorrow':
  // 'next-week' does exactly that every Sunday, rendering an identical chip.
  await page.getByTestId('snooze-preset-later-today').click()
  await expect(rows.first().getByTestId('chip-snooze-due')).not.toHaveText(originalDue ?? '')
  await page.keyboard.press('z')
  await expect(rows).toHaveCount(1)
  await expect(rows.first().getByTestId('chip-snooze-due')).toHaveText(originalDue ?? '')

  await page.keyboard.press('e')
  await expect(rows).toHaveCount(0)
  await page.keyboard.press('z')
  await expect(rows).toHaveCount(1)
  await expect(rows.first().getByTestId('chip-snooze-due')).toHaveText(originalDue ?? '')
})

test('snoozes every selected conversation, not just the focused one', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await page.keyboard.press('x')
  await page.keyboard.press('Shift+J')
  await page.keyboard.press('Shift+J')
  await expect(page.getByTestId('selection-count')).toHaveText('3 selected')

  await page.keyboard.press('h')
  await expect(page.getByTestId('snooze-subtitle')).toHaveText('Choose when these 3 conversations return.')
  await page.getByTestId('snooze-preset-tomorrow').click()

  await expect(rows).toHaveCount(5)
  await expect(page.getByTestId('toast')).toHaveText('3 snoozed')
  await expect(page.getByTestId('selection-count')).toHaveCount(0)

  await page.keyboard.press('g')
  await page.keyboard.press('h')
  await expect(rows).toHaveCount(3)

  // One undo reverses the whole bulk snooze (F4).
  await page.keyboard.press('z')
  await expect(rows).toHaveCount(0)
  await page.keyboard.press('g')
  await page.keyboard.press('i')
  await expect(rows).toHaveCount(8)
})

test('unrelated reader keys disarm a pending go chord', async ({ page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-content')).toBeVisible()
  await page.keyboard.press('g')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('h')
  await expect(page.getByTestId('view-title')).toHaveText('Inbox')
  await expect(page.getByTestId('snooze-picker')).toBeVisible()
})

test('returns a due snooze to the inbox with a returned chip', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await page.evaluate(async () => {
    const [thread] = await window.attn.mail.listThreads()
    await window.attn.mail.snooze([thread.id], Date.now() + 800)
  })
  await expect(rows).toHaveCount(7)
  const returned = rows.filter({ hasText: 'Maya Lin' })
  await expect.poll(() => returned.count(), { timeout: 5_000 }).toBe(1)
  await expect(returned.getByTestId('chip-returned')).toBeVisible()
  await returned.click()
  await page.keyboard.press('Enter')
  await expect(returned.getByTestId('chip-returned')).toHaveCount(0)
})

test('catches up a snooze that became due while the app was closed', async ({ boot }) => {
  let page = await boot.app.firstWindow()
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await page.evaluate(async () => {
    const [thread] = await window.attn.mail.listThreads()
    await window.attn.mail.snooze([thread.id], Date.now() + 600)
  })
  await expect(rows).toHaveCount(7)

  ;({ page } = await boot.relaunch({ waitBeforeLaunch: 1_000 }))
  const returned = page.getByTestId('thread-row').filter({ hasText: 'Maya Lin' })
  await expect(returned).toHaveCount(1)
  await expect(returned.getByTestId('chip-returned')).toBeVisible()
})
