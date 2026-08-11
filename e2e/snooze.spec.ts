import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-inbox.json' })

test('snoozes from the picker, navigates to Snoozed, and undoes', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await page.keyboard.press('h')
  await expect(page.getByTestId('snooze-picker')).toBeVisible()
  await page.getByTestId('snooze-preset-tomorrow').click()
  await expect(rows).toHaveCount(7)

  await page.keyboard.press('g')
  await page.keyboard.press('h')
  await expect(page.getByTestId('view-title')).toHaveText('Snoozed')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toContainText('Maya Lin')
  await expect(rows.first().getByTestId('chip-snooze-due')).toBeVisible()

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
