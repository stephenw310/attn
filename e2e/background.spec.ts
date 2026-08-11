import { expect, test } from './electron'

test('closing the window keeps the app alive until an explicit quit', async ({ app, page }) => {
  expect(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(false)

  if (process.platform === 'win32') {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()))
      .toBe(false)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  } else {
    await page.close()
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0)
  }
  expect(await app.evaluate(({ app: electronApp }) => electronApp.isReady())).toBe(true)

  const exited = new Promise<number | null>((resolve) => app.process().once('exit', resolve))
  await app.evaluate(({ app: electronApp }) => electronApp.quit())
  await expect(exited).resolves.toBe(0)
})

test('development and test runs do not register a login item', async ({ app }) => {
  const settings = await app.evaluate(({ app: electronApp }) => electronApp.getLoginItemSettings())
  expect(settings.openAtLogin).toBe(false)
})

test.describe('login launch', () => {
  test.use({ appArgs: ['--hidden'] })

  test('a --hidden launch is windowless until asked to show (F16)', async ({ app, page }) => {
    // Wait for the renderer to fully render first — before that, an invisible
    // window proves nothing about the startHidden path.
    await expect(page.getByTestId('thread-row').first()).toBeVisible()
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(
      false
    )

    // activate routes through showMainWindow — the same path Dock clicks take.
    await app.evaluate(({ app: electronApp }) => electronApp.emit('activate'))
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()))
      .toBe(true)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
  })
})
