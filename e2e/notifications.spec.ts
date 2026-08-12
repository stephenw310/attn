import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-inbox.json' })

test('focus-thread push selects the requested row and opens its conversation', async ({ app, page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await expect(page.getByTestId('conversation-pane')).toHaveCount(0)

  await app.evaluate(({ ipcMain }) => {
    ipcMain.emit('attn:test:focusThread', {}, 't-budget')
  })

  await expect(page.getByTestId('conversation-pane')).toBeVisible()
  await expect(page.getByTestId('conversation-subject')).toHaveText('August budget')
  await expect(page.getByTestId('thread-row').filter({ hasText: 'August budget' })).toHaveAttribute(
    'data-selected',
    'true'
  )
})

test('a notification target survives recreating a closed window', async ({ app, page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  const windowCreated = app.waitForEvent('window')
  await app.evaluate(({ BrowserWindow, ipcMain }) => {
    for (const win of BrowserWindow.getAllWindows()) win.destroy()
    ipcMain.emit('attn:test:focusThread', {}, 't-budget')
  })

  const reopened = await windowCreated
  await expect(reopened.getByTestId('thread-row')).toHaveCount(8)
  await expect(reopened.getByTestId('conversation-subject')).toHaveText('August budget')
  await expect(reopened.getByTestId('thread-row').filter({ hasText: 'August budget' })).toHaveAttribute(
    'data-selected',
    'true'
  )
})

test('focus-thread safely leaves an open Snoozed conversation before opening Inbox', async ({
  app,
  page
}) => {
  const rows = page.getByTestId('thread-row')
  await expect(rows).toHaveCount(8)
  await page.keyboard.press('x')
  for (let index = 0; index < 4; index++) await page.keyboard.press('Shift+J')
  await page.keyboard.press('h')
  await page.getByTestId('snooze-preset-tomorrow').click()

  await page.keyboard.press('g')
  await page.keyboard.press('h')
  await expect(rows).toHaveCount(5)
  await page.keyboard.press('j')
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-subject')).toHaveText('Your receipt')
  const pendingBefore = await page.evaluate(() => window.attn.mail.getPendingActionCount())

  await app.evaluate(({ ipcMain }) => {
    ipcMain.emit('attn:test:focusThread', {}, 't-travel')
  })

  await expect(page.getByTestId('view-title')).toHaveText('Inbox')
  await expect(page.getByTestId('conversation-subject')).toHaveText('Flight options')
  await expect.poll(() => page.evaluate(() => window.attn.mail.getPendingActionCount())).toBe(pendingBefore)
})
