import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './electron'
import { runPaletteCommand } from './nav'

test.use({ seed: 'fixtures/seed-inbox.json' })

test('Tide palettes preserve appearance, persist, and keep app text readable', async ({
  page,
  boot
}, testInfo) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  mkdirSync(join(__dirname, '.artifacts'), { recursive: true })
  for (const appearance of ['Light', 'Dark']) {
    await runPaletteCommand(page, `Use ${appearance} theme`)
    for (const palette of ['Matcha', 'Mist', 'Linen', 'Dusk']) {
      await runPaletteCommand(page, `Use ${palette} color palette`)
      await expect(page.locator('html')).toHaveAttribute('data-palette', palette.toLowerCase())
      await expect(page.locator('html')).toHaveAttribute('data-theme-appearance', appearance.toLowerCase())
      const contrast = await page.evaluate(() => {
        const style = getComputedStyle(document.documentElement)
        const luminance = (hex: string) => {
          const values = (hex.trim().slice(1).match(/.{2}/g) ?? []).map((value) => {
            const srgb = Number.parseInt(value, 16) / 255
            return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
          })
          return values[0] * 0.2126 + values[1] * 0.7152 + values[2] * 0.0722
        }
        const ratio = (a: string, b: string) => {
          const x = luminance(style.getPropertyValue(`--attn-${a}`))
          const y = luminance(style.getPropertyValue(`--attn-${b}`))
          return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05)
        }
        return ['ground', 'raised', 'active']
          .flatMap((background) =>
            ['ink', 'ink-dim', 'ink-faint'].map((text) => ({
              background,
              text,
              ratio: ratio(background, text)
            }))
          )
          .concat([{ background: 'accent', text: 'on-accent', ratio: ratio('accent', 'on-accent') }])
      })
      for (const pair of contrast)
        expect(pair.ratio, `${palette} ${appearance} ${pair.text}/${pair.background}`).toBeGreaterThanOrEqual(
          4.5
        )
      const path = join(
        __dirname,
        '.artifacts',
        `tide-${palette.toLowerCase()}-${appearance.toLowerCase()}.png`
      )
      await page.mouse.move(0, 0)
      await page.screenshot({ path })
      await testInfo.attach(`${palette} ${appearance}`, { path, contentType: 'image/png' })
    }
  }
  await expect
    .poll(() => page.evaluate(async () => (await window.attn.settings.getAll()).palette))
    .toBe('dusk')
  const relaunched = await boot.relaunch()
  await expect(relaunched.page.locator('html')).toHaveAttribute('data-palette', 'dusk')
  await expect(relaunched.page.locator('html')).toHaveAttribute('data-theme', 'dispatch-dark')
  await expect.poll(() => relaunched.page.evaluate(() => window.attn.settings.initialPalette)).toBe('dusk')
})

test.describe('Tide split shell', () => {
  test.use({ seed: 'fixtures/seed-splits.json' })
  test('Tide keeps Write fixed, restores sidebar preference, and boxes shortcut hints', async ({
    page,
    app
  }, testInfo) => {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(900, 700))
    await expect.poll(() => page.evaluate(() => innerWidth)).toBe(900)
    await expect(page.getByTestId('thread-row').first()).toBeVisible()
    await runPaletteCommand(page, 'Use Light theme')
    const write = page.getByTestId('write-button')
    const original = await write.boundingBox()
    const sidebar = await page.getByTestId('mail-sidebar').boundingBox()
    const toggle = await page.getByTestId('sidebar-toggle').boundingBox()
    if (!sidebar || !toggle) throw new Error('Sidebar and toggle must be visible')
    expect(toggle.x).toBe(sidebar.x + sidebar.width)
    await expect(page.getByTestId('mail-sidebar').locator('kbd')).toHaveCount(0)
    await page.getByTestId('sidebar-toggle').click()
    await expect(page.getByTestId('sidebar-brand')).toHaveCount(0)
    expect(await write.boundingBox()).toEqual(original)
    await page.getByTestId('sidebar-toggle').click()
    expect(await write.boundingBox()).toEqual(original)
    await page.keyboard.press('ControlOrMeta+,')
    await expect(page.getByTestId('settings-view')).toBeVisible()
    await expect(page.getByTestId('mail-sidebar')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('mail-sidebar')).toBeVisible()
    await page.getByTestId('split-rules-settings').click()
    await expect(page.getByTestId('mail-sidebar')).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('mail-sidebar')).toBeVisible()
    await expect(page.getByTestId('mail-footer').locator('kbd').first()).toHaveCSS('border-top-width', '1px')
    await page.getByTestId('footer-all-shortcuts').click()
    await expect(page.getByTestId('cheat-sheet')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('thread-row').first()).toHaveCSS('height', '54px')
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)
    expect(overflow).toBe(false)
    mkdirSync(join(__dirname, '.artifacts'), { recursive: true })
    const path = join(__dirname, '.artifacts', 'tide-narrow-inbox.png')
    await page.screenshot({ path })
    await testInfo.attach('Tide narrow inbox', { path, contentType: 'image/png' })
    await write.click()
    await expect(page.getByTestId('composer')).toBeVisible()
  })
})
