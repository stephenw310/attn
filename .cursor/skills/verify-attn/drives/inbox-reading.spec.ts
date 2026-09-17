import { expect, test } from '../../../../e2e/electron'
import { selectedIndex } from '../../../../e2e/nav'
import { assertIsolated, record, snap } from './harness'

test.use({ seed: 'fixtures/seed-inbox.json' })

test('opens a conversation from the list and marks it read in the store', async ({
  app,
  page,
  userData,
  mainLog
}, testInfo) => {
  await assertIsolated(app, userData, mainLog)

  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  const unreadBefore = await page.evaluate(() => window.attn.mail.getUnreadCount())
  await snap(page, testInfo, '01-inbox-list')

  await page.keyboard.press('j')
  await page.keyboard.press('j')
  await expect.poll(() => selectedIndex(page)).toBe(2)
  await expect(rows.nth(2)).toHaveAttribute('data-unread', 'true')

  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Design notes')
  await snap(page, testInfo, '02-reader')

  await expect.poll(() => page.evaluate(() => window.attn.mail.getUnreadCount())).toBe(unreadBefore - 1)
  const unreadAfter = await page.evaluate(() => window.attn.mail.getUnreadCount())
  record(testInfo, 'unread-count.json', { unreadBefore, unreadAfter })

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('thread-list')).toBeVisible()
  await expect(rows.nth(2)).not.toHaveAttribute('data-unread', 'true')
  await snap(page, testInfo, '03-back-to-list')
})
