import { ComposerPage } from './composer'
import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-junk-reply.json' })

test('Trash rows and replies use the visible Trash message', async ({ page }) => {
  await page.getByTestId('sidebar-mailbox').filter({ hasText: 'Trash' }).click()
  await expect(page.getByTestId('mailbox-title')).toHaveText('Trash')

  const row = page.getByTestId('thread-row')
  await expect(row).toHaveCount(1)
  await expect(row.getByTestId('thread-sender')).toHaveText('Deleted Sender')
  await expect(row).toContainText('This copy belongs in Trash.')
  await row.click()
  await expect(page.getByTestId('conversation-content')).toContainText('This copy belongs in Trash.')
  await expect(page.getByTestId('conversation-content')).not.toContainText('This copy belongs in Inbox.')

  const composer = new ComposerPage(page)
  await composer.openReply()
  await composer.expectRecipients(['deleted@example.com'])
})
