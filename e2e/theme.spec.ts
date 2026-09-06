import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ComposerPage } from './composer'
import { expect, test } from './electron'
import { openPalette, runPaletteCommand } from './nav'

test.use({ seed: 'fixtures/seed-inbox.json' })

async function chooseTheme(page: import('@playwright/test').Page, theme: string): Promise<void> {
  await page.getByTestId('account-menu').getByRole('button').first().click()
  await expect(page.getByTestId('theme-picker').locator('option')).toHaveText(['System', 'Dark', 'Light'])
  await page.getByTestId('theme-picker').selectOption(theme)
  await expect(page.locator('html')).toHaveAttribute(
    'data-theme',
    theme === 'system' ? /dispatch-(?:dark|light)/ : theme
  )
  await page.keyboard.press('Escape')
}

test('System follows the OS while a named palette persists across relaunch', async ({ boot, page }) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  await chooseTheme(page, 'system')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dispatch-dark')

  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dispatch-light')
  await expect(page.locator('html')).toHaveAttribute('data-theme-appearance', 'light')

  await chooseTheme(page, 'dispatch-dark')
  await page.emulateMedia({ colorScheme: 'light' })
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dispatch-dark')

  const relaunched = await boot.relaunch()
  await expect(relaunched.page.getByTestId('thread-row')).toHaveCount(8)
  await expect
    .poll(() => relaunched.page.evaluate(() => window.attn.settings.initialTheme))
    .toBe('dispatch-dark')
  await expect(relaunched.page.locator('html')).toHaveAttribute('data-theme', 'dispatch-dark')
  await expect(relaunched.page.locator('html')).toHaveAttribute('data-theme-appearance', 'dark')
})

for (const appearance of ['dark', 'light'] as const) {
  test(`${appearance} scrollbars match across panes, composer, and mail frames`, async ({
    app,
    page
  }, testInfo) => {
    await expect(page.getByTestId('thread-row')).toHaveCount(8)
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(1100, 700))
    await runPaletteCommand(page, `Use ${appearance === 'dark' ? 'Dark' : 'Light'} theme`)
    const expectedThumb = appearance === 'dark' ? 'rgb(65, 68, 77)' : 'rgb(184, 178, 167)'
    const assertScrollbar = async (locator: import('@playwright/test').Locator, color = expectedThumb) => {
      await page.mouse.move(0, 0)
      expect(
        await locator.evaluate((element) => {
          const style = (pseudo: string) => getComputedStyle(element, pseudo)
          return {
            width: style('::-webkit-scrollbar').width,
            thumb: style('::-webkit-scrollbar-thumb').backgroundColor,
            track: style('::-webkit-scrollbar-track').backgroundColor
          }
        })
      ).toEqual({ width: '10px', thumb: color, track: 'rgba(0, 0, 0, 0)' })
    }
    const capture = async (name: string) => {
      mkdirSync(join(__dirname, '.artifacts'), { recursive: true })
      const path = join(__dirname, '.artifacts', `scrollbars-${name}-${appearance}.png`)
      await page.screenshot({ path })
      await testInfo.attach(`scrollbars-${name}-${appearance}`, { path, contentType: 'image/png' })
    }
    await assertScrollbar(page.getByTestId('sidebar-labels'))
    await assertScrollbar(page.getByTestId('thread-list'))
    await capture('inbox')
    await page.keyboard.press('ControlOrMeta+,')
    await expect(page.getByTestId('settings-theme').locator('option')).toHaveText(['System', 'Dark', 'Light'])
    await capture('settings')
    await page.keyboard.press('Escape')
    const composer = new ComposerPage(page)
    await composer.openNew()
    await composer.typeBody(Array.from({ length: 35 }, (_, i) => `Draft line ${i + 1}`).join('\n'))
    await assertScrollbar(composer.editor)
    await capture('composer')
    await page.keyboard.press('Escape')
    await expect(composer.root).toHaveCount(0)
    await page.getByTestId('thread-row').filter({ hasText: 'Your receipt' }).click()
    const frame = page.frameLocator('[data-testid="html-body-frame"]')
    await assertScrollbar(frame.locator('html'))
    if (appearance === 'dark') {
      await page.getByTestId('mail-original-toggle').click()
      await assertScrollbar(frame.locator('html'), 'rgb(184, 178, 167)')
    }
    await capture('mail')
    await openPalette(page, 'Use Sand theme')
    await expect(page.getByTestId('command-palette')).not.toContainText('Use Sand theme')
    await page.keyboard.press('Escape')
    await openPalette(page, 'Use Midnight theme')
    await expect(page.getByTestId('command-palette')).not.toContainText('Use Midnight theme')
  })
}

test('light mail uses sender colors and dark mail offers the original rendering', async ({
  page
}, testInfo) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await chooseTheme(page, 'dispatch-light')
  const directory = join(__dirname, '.artifacts')
  mkdirSync(directory, { recursive: true })
  const inboxPath = join(directory, 'inbox-light.png')
  await page.screenshot({ path: inboxPath })
  await testInfo.attach('Light inbox', { path: inboxPath, contentType: 'image/png' })

  await page.getByTestId('thread-row').filter({ hasText: 'Your receipt' }).click()
  await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-appearance', 'light')
  await expect(page.getByTestId('mail-original-toggle')).toHaveCount(0)
  await expect(page.frameLocator('[data-testid="html-body-frame"]').locator('body')).toHaveCSS(
    'color',
    'rgb(32, 33, 36)'
  )

  await page.keyboard.press('Escape')
  await chooseTheme(page, 'dispatch-dark')
  await page.getByTestId('thread-row').filter({ hasText: 'Your receipt' }).click()
  await expect(page.getByTestId('mail-original-toggle')).toHaveText('View original')
  await page.getByTestId('mail-original-toggle').click()
  await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-surface', 'light')
  await expect(page.getByTestId('mail-original-toggle')).toHaveText('Use dark view')

  await page.keyboard.press('Escape')
  await chooseTheme(page, 'dispatch-light')
  await page.getByTestId('thread-row').filter({ hasText: 'This week in focus' }).click()
  await expect(page.getByTestId('html-body-frame')).toBeVisible()
  const readingPath = join(directory, 'reading-light.png')
  await page.screenshot({ path: readingPath })
  await testInfo.attach('Light reading', { path: readingPath, contentType: 'image/png' })
})
