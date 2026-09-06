import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ComposerPage } from './composer'
import { expect, test } from './electron'
import { runPaletteCommand } from './nav'

test('closing the window keeps the app alive until an explicit quit', async ({ app, page }) => {
  expect(await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)).toBe(false)

  if (process.platform === 'win32' || process.platform === 'darwin') {
    await app.evaluate(({ app: electronApp }) => electronApp.emit('activate'))
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()))
      .toBe(false)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    if (process.platform === 'darwin') {
      await expect
        .poll(() => app.evaluate(({ app: electronApp }) => electronApp.dock?.isVisible()))
        .toBe(false)
    }
  } else {
    await page.close()
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(0)
  }
  expect(await app.evaluate(({ app: electronApp }) => electronApp.isReady())).toBe(true)

  const exited = new Promise<number | null>((resolve) => app.process().once('exit', resolve))
  await app.evaluate(({ app: electronApp }) => electronApp.quit())
  await expect(exited).resolves.toBe(0)
})

test('extends web content into the native title bar', async ({ app, page }) => {
  await expect(page.getByTestId('login-screen')).toBeVisible()
  const sizes = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    return win ? { window: win.getBounds(), content: win.getContentBounds() } : null
  })
  expect(sizes).not.toBeNull()
  expect(Math.abs((sizes?.window.height ?? 0) - (sizes?.content.height ?? 0))).toBeLessThanOrEqual(2)
})

test.describe('login launch', () => {
  test.use({ appArgs: ['--hidden'] })

  test('a --hidden launch is windowless until asked to show (F16)', async ({ app, page }) => {
    // Wait for the renderer to fully render first — before that, an invisible
    // window proves nothing about the startHidden path.
    await expect(page.getByTestId('login-screen')).toBeVisible()
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible())).toBe(
      false
    )
    if (process.platform === 'darwin') {
      expect(await app.evaluate(({ app: electronApp }) => electronApp.dock?.isVisible())).toBe(false)
    }

    // activate routes through showMainWindow — the same path Dock clicks take.
    await app.evaluate(({ app: electronApp }) => electronApp.emit('activate'))
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()))
      .toBe(true)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(1)
    if (process.platform === 'darwin') {
      await expect
        .poll(() => app.evaluate(({ app: electronApp }) => electronApp.dock?.isVisible()))
        .toBe(true)
    }
  })
})

test.describe('background draft', () => {
  test.use({ seed: 'fixtures/seed-inbox.json' })

  test('the close-window command preserves an open draft through reopening', async ({
    app,
    page
  }, testInfo) => {
    test.skip(process.platform === 'linux', 'Close to tray is supported on macOS and Windows')
    await app.evaluate(({ app: electronApp }) => electronApp.emit('activate'))
    const windowId = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id)
    const composer = new ComposerPage(page)
    await composer.openNew()
    await composer.addRecipient('friend@example.com')
    await composer.subject.fill('Keep this draft open')
    await composer.typeBody('Still here after reopening Attn.')
    await runPaletteCommand(page, 'Close window and keep Attn running')
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()))
      .toBe(false)
    await app.evaluate(({ app: electronApp }) => electronApp.emit('activate'))
    await expect
      .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.isVisible()))
      .toBe(true)
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].id)).toBe(windowId)
    await expect(composer.root).toBeVisible()
    await expect(composer.subject).toHaveValue('Keep this draft open')
    await expect(composer.editor).toContainText('Still here after reopening Attn.')
    await composer.expectRecipients(['friend@example.com'])
    if (process.platform === 'darwin') {
      await page.keyboard.press('Escape')
      await expect(composer.root).toHaveCount(0)
      await page.keyboard.press('ControlOrMeta+,')
      await expect(page.getByTestId('settings-view')).toBeVisible()
      const icon = page.getByTestId('settings-menu-bar-icon')
      await expect(icon).not.toBeChecked()
      await icon.evaluate((element) => element.closest('section')?.scrollIntoView({ block: 'start' }))
      mkdirSync(join(__dirname, '.artifacts'), { recursive: true })
      for (const colorScheme of ['dark', 'light'] as const) {
        await page.emulateMedia({ colorScheme })
        const path = join(__dirname, '.artifacts', `settings-background-${colorScheme}.png`)
        await page.screenshot({ path })
        await testInfo.attach(`settings-background-${colorScheme}`, { path, contentType: 'image/png' })
      }
    }
  })
})
