import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-inbox.json' })

test('focus-thread push selects the requested row and opens its conversation', async ({ app, page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await expect(page.getByTestId('conversation-pane')).toHaveCount(0)

  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('mail:focusThread', { threadId: 't-budget' })
  })

  await expect(page.getByTestId('conversation-pane')).toBeVisible()
  await expect(page.getByTestId('conversation-subject')).toHaveText('August budget')
  await expect(page.getByTestId('thread-row').filter({ hasText: 'August budget' })).toHaveAttribute(
    'data-selected',
    'true'
  )
})
