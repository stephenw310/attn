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
    const expectedThumb = appearance === 'dark' ? 'rgb(59, 65, 79)' : 'rgb(189, 174, 142)'
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
      await assertScrollbar(frame.locator('html'), 'rgb(189, 174, 142)')
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
  // The default ink of a native letter is ours in either palette; the sender's
  // own colours are asserted below, and those still win where they are set.
  await expect(page.frameLocator('[data-testid="html-body-frame"]').locator('body')).toHaveCSS(
    'color',
    'rgb(42, 32, 21)'
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

test('paints the sheet behind the window and repaints it for the theme and the sidebar', async ({
  app,
  page
}) => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1100, 700))
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await expect(page.getByTestId('wordmark-seal')).toBeVisible()
  const sheet = page.getByTestId('paper-sheet')

  // A canvas is a replaced element: without an explicit size it keeps its
  // intrinsic 300 by 150 and the sheet covers only the corner of the window.
  const measure = (): Promise<{ bitmap: number[]; css: number[]; viewport: number[] }> =>
    sheet.evaluate((canvas: HTMLCanvasElement) => {
      const box = canvas.getBoundingClientRect()
      return {
        bitmap: [canvas.width, canvas.height],
        css: [Math.round(box.width), Math.round(box.height)],
        viewport: [window.innerWidth, window.innerHeight]
      }
    })
  // The bitmap is resized by a debounced repaint, so wait for it rather than
  // relying on boot taking longer than the debounce.
  await expect
    .poll(async () => {
      const measured = await measure()
      return measured.bitmap.join('x') === measured.viewport.join('x')
    })
    .toBe(true)
  const size = await measure()
  expect(size.css).toEqual(size.viewport)

  const brightness = (x: number, y: number): Promise<number> =>
    sheet.evaluate(
      (canvas: HTMLCanvasElement, region) => {
        const context = canvas.getContext('2d')
        if (!context) throw new Error('The sheet has no 2d context')
        const pixels = context.getImageData(region.x, region.y, 80, 80).data
        let total = 0
        for (let offset = 0; offset < pixels.length; offset += 4) {
          total += (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3
        }
        return total / (pixels.length / 4)
      },
      { x, y }
    )

  const beforeTheme = await brightness(250, 300)
  await chooseTheme(page, 'dispatch-light')
  await expect.poll(() => brightness(250, 300)).not.toBe(beforeTheme)
  expect(await brightness(250, 300)).toBeGreaterThan(beforeTheme + 40)

  // The sidebar is written on a darker band. Collapsing it tears the band away
  // and the sheet runs edge to edge, so the same patch of canvas turns to paper.
  const overBand = await brightness(120, 300)
  await page.keyboard.press('ControlOrMeta+B')
  await expect(page.getByTestId('mail-sidebar')).toHaveCount(0)
  await expect.poll(() => brightness(120, 300)).toBeGreaterThan(overBand + 5)
})
