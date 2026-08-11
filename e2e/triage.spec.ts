import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-inbox.json' })

test('archives with auto-advance and undoes durably', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await expect(rows.nth(1)).toContainText('Northstar Books')
  await page.keyboard.press('e')
  await expect(rows).toHaveCount(7)
  await expect(rows.first()).toContainText('Northstar Books')
  await expect(rows.first()).toHaveAttribute('data-selected', 'true')
  await expect(page.getByTestId('pending-count')).toContainText('1 pending')
  await page.keyboard.press('z')
  await expect(rows).toHaveCount(8)
  await expect(page.getByTestId('pending-count')).toContainText('2 pending')
})

test('toggles star and unread, then trashes', async ({ page }) => {
  const first = page.getByTestId('thread-row').first()
  await expect(first).toHaveAttribute('data-unread', 'true')
  await first.click()
  await page.keyboard.press('s')
  await expect(first.getByTitle('Starred')).toBeVisible()
  await page.keyboard.press('u')
  await expect(first).not.toHaveAttribute('data-unread')
  await page.keyboard.press('#')
  await expect(page.getByTestId('thread-row')).toHaveCount(7)
  await expect(page.getByTestId('pending-count')).toContainText('3 pending')
})

test('keeps offline actions across relaunch without reseeding', async ({ boot }) => {
  let page = await boot.app.firstWindow()
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await page.getByTestId('thread-row').first().click()
  for (let i = 0; i < 3; i++) {
    await page.keyboard.press('e')
    await expect(page.getByTestId('thread-row')).toHaveCount(7 - i)
  }
  ;({ page } = await boot.relaunch())
  await expect(page.getByTestId('thread-row')).toHaveCount(5)
  await expect(page.getByTestId('pending-count')).toContainText('3 pending')
  expect(boot.mainLog().match(/\[log\] \[seed\] loaded/g)).toHaveLength(1)
})

test('triages from the overlay and advances the open conversation', async ({ page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-subject')).toHaveText('Q3 roadmap review')
  await page.keyboard.press('e')
  await expect(page.getByTestId('conversation-overlay')).toBeVisible()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Your receipt')
  await expect(page.getByTestId('thread-row')).toHaveCount(7)
  await page.keyboard.press('z')
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await expect(page.getByTestId('conversation-subject')).toHaveText('Q3 roadmap review')
})

test('keeps explicit unread and undo stable while the overlay is open', async ({ page }) => {
  const first = page.getByTestId('thread-row').first()
  await expect(first).toHaveAttribute('data-unread', 'true')
  await first.click()
  await page.keyboard.press('Enter')
  await expect(first).not.toHaveAttribute('data-unread')
  await page.keyboard.press('u')
  await expect(first).toHaveAttribute('data-unread', 'true')
  await page.keyboard.press('z')
  await expect(first).not.toHaveAttribute('data-unread')
})

test('does not run destructive shortcuts with command modifiers', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await rows.first().click()
  await page.keyboard.press('Meta+e')
  await page.keyboard.press('Control+u')
  await page.keyboard.press('Alt+e')
  await expect(rows).toHaveCount(8)
  await expect(page.getByTestId('pending-count')).toHaveCount(0)
})

test('keeps a valid selection after navigating an empty inbox', async ({ page }) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await rows.first().click()
  for (let remaining = 7; remaining >= 0; remaining--) {
    await page.keyboard.press('e')
    await expect(rows).toHaveCount(remaining)
  }
  await page.keyboard.press('j')
  await page.keyboard.press('z')
  await expect(rows).toHaveCount(1)
  await expect(rows.first()).toHaveAttribute('data-selected', 'true')
  await page.keyboard.press('e')
  await expect(rows).toHaveCount(0)
})
