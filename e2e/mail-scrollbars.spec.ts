import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './electron'
import { runPaletteCommand } from './nav'

test.use({ seed: 'fixtures/seed-scrollbars.json' })

for (const appearance of ['Dark', 'Light'] as const) {
  test(`sender CSS cannot replace ${appearance} mail scrollbars`, async ({ page }, testInfo) => {
    await runPaletteCommand(page, `Use ${appearance} theme`)
    await page.getByTestId('thread-row').filter({ hasText: 'Sender scrollbar styles' }).click()
    const frame = page.frameLocator('[data-testid="html-body-frame"]')
    await expect(frame.locator('body')).toContainText('Sender content wider')
    await page.mouse.move(0, 0)
    const assertChrome = async () => {
      expect(
        await frame.locator('html').evaluate((element) => {
          const scrollbar = getComputedStyle(element, '::-webkit-scrollbar')
          const thumb = getComputedStyle(element, '::-webkit-scrollbar-thumb')
          return {
            width: scrollbar.width,
            height: scrollbar.height,
            display: scrollbar.display,
            thumb: thumb.backgroundColor,
            radius: thumb.borderRadius,
            track: getComputedStyle(element, '::-webkit-scrollbar-track').backgroundColor,
            standardWidth: getComputedStyle(element).scrollbarWidth
          }
        })
      ).toEqual({
        width: '10px',
        height: '10px',
        display: 'block',
        thumb: 'rgb(189, 174, 142)',
        radius: '999px',
        track: 'rgba(0, 0, 0, 0)',
        standardWidth: 'auto'
      })
    }
    // Designed sender mail keeps its light canvas in either app theme.
    await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-surface', 'light')
    await assertChrome()
    mkdirSync(join(__dirname, '.artifacts'), { recursive: true })
    const path = join(__dirname, '.artifacts', `sender-scrollbars-${appearance}.png`)
    await page.screenshot({ path })
    await testInfo.attach(`Sender scrollbars ${appearance}`, { path, contentType: 'image/png' })
  })
}
