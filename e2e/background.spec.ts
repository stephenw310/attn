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
