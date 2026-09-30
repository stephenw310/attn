import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './electron'
import { runPaletteCommand, threadRow } from './nav'

test.use({ seed: 'fixtures/seed-mail-image-sizing.json' })

for (const appearance of ['light', 'dark'] as const) {
  test(`preserves thin email headers and responsive image proportions in ${appearance}`, async ({
    page
  }, testInfo) => {
    let releaseImage!: () => void
    const imageGate = new Promise<void>((resolve) => {
      releaseImage = resolve
    })
    await page.route('https://sizing.attn.test/**', async (route) => {
      await imageGate
      await route.fulfill({
        contentType: 'image/gif',
        body: Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64')
      })
    })
    await runPaletteCommand(page, `Use ${appearance === 'dark' ? 'Dark' : 'Light'} theme`)
    await threadRow(page, 'Alert with a thin image header').click()
    const frame = page.getByTestId('html-body-frame')
    const body = page.frameLocator('[data-testid="html-body-frame"]')
    const header = body.locator('#header-image')
    await expect(header).toHaveCSS('visibility', 'hidden')
    await expect(header).toHaveAttribute('data-attn-image-pending', '')
    releaseImage()
    await expect(header).toHaveCSS('visibility', 'visible')
    for (const canvasWidth of [600, 300]) {
      await body.locator('#alert-canvas').evaluate((canvas, width) => {
        canvas.style.width = `${width}px`
      }, canvasWidth)
      await expect
        .poll(() =>
          header.evaluate((image) => {
            const bounds = image.getBoundingClientRect()
            return Math.abs(bounds.width / bounds.height - 25) < 0.1
          })
        )
        .toBe(true)
      expect(
        await body.locator('#spacer-image').evaluate((image) => image.getBoundingClientRect().height)
      ).toBeLessThanOrEqual(1)
      await expect.poll(() => frame.evaluate((element) => element.clientHeight)).toBeLessThan(200)
    }
    await expect(body.locator('#natural-image')).toHaveCSS('height', '24px')
    await expect(body.locator('#authored-ratio')).toHaveCSS('height', '12px')
    await expect(body.locator('#stylesheet-ratio')).toHaveCSS('height', '12px')
    await expect(body.locator('#alert-copy')).toBeVisible()
    const directory = join(__dirname, '.artifacts')
    mkdirSync(directory, { recursive: true })
    const path = join(directory, `mail-image-sizing-${appearance}.png`)
    await page.screenshot({ path })
    await testInfo.attach(`mail-image-sizing-${appearance}`, { path, contentType: 'image/png' })
  })
}
