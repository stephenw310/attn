import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './electron'
import { runPaletteCommand, threadRow } from './nav'

test.use({ seed: 'fixtures/seed-mail-height.json' })

for (const appearance of ['light', 'dark'] as const) {
  test(`keeps percentage-height mail stable and resizes content in ${appearance}`, async ({
    page
  }, testInfo) => {
    await runPaletteCommand(page, `Use ${appearance === 'dark' ? 'Dark' : 'Light'} theme`)
    for (const subject of ['Percentage-height letter', 'Logical-height wide letter', 'Fixed-height letter']) {
      await threadRow(page, subject).click()
      const frame = page.getByTestId('html-body-frame')
      const body = page.frameLocator('[data-testid="html-body-frame"]')
      await expect(frame).toBeVisible()
      await expect(body.locator('body')).toHaveCSS('margin-top', '20px')
      await expect(body.locator('body')).toHaveCSS('padding-top', '16px')
      if (subject === 'Fixed-height letter') {
        await expect(body.locator('body')).toHaveCSS('height', '500px')
      }
      await expect
        .poll(() =>
          frame.evaluate((element) => {
            const frame = element as HTMLIFrameElement
            const doc = frame.contentDocument
            const end = doc?.querySelector('#letter-end')?.getBoundingClientRect().bottom
            if (!doc || end === undefined) return false
            return end <= doc.documentElement.clientHeight && frame.clientHeight < 800
          })
        )
        .toBe(true)
      // Watch actual animation frames: the regression adds height on each resize.
      const heights = await frame.evaluate(async (element) => {
        const heights: number[] = []
        for (let i = 0; i < 20; i++) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
          heights.push(element.clientHeight)
        }
        return heights
      })
      expect(Math.max(...heights) - Math.min(...heights)).toBeLessThanOrEqual(1)
      await expect(page.getByTestId('plain-text-body')).toHaveCount(0)
      await expect(frame).toHaveAttribute('data-load-count', '1')
      mkdirSync(join(__dirname, '.artifacts'), { recursive: true })
      const path = join(__dirname, '.artifacts', `mail-height-${subject.split(' ')[0]}-${appearance}.png`)
      await page.screenshot({ path })
      await testInfo.attach(`${subject} ${appearance}`, { path, contentType: 'image/png' })

      if (subject !== 'Fixed-height letter') {
        await body.locator('#changing-content').evaluate((element) => {
          element.style.height = '80px'
        })
        await expect
          .poll(() => frame.evaluate((element) => element.clientHeight))
          .toBeLessThan(heights[0] - 100)
      }
      if (subject === 'Logical-height wide letter') {
        await expect
          .poll(() => body.locator('html').evaluate((element) => element.scrollWidth > element.clientWidth))
          .toBe(true)
        await body.locator('html').evaluate((element) => {
          element.scrollLeft = element.scrollWidth
        })
        await expect
          .poll(() => body.locator('html').evaluate((element) => element.scrollLeft))
          .toBeGreaterThan(0)
        await body.locator('html').evaluate((element) => {
          element.scrollLeft = 0
        })
      }
      if (subject === 'Fixed-height letter') {
        // Fallback destroys the frame, so mutate it from the parent's context.
        await frame.evaluate((element) => {
          const doc = (element as HTMLIFrameElement).contentDocument
          if (!doc) throw new Error('Mail document missing')
          doc.body.style.setProperty('height', '100001px', 'important')
        })
        await expect(page.getByTestId('plain-text-body')).toContainText('Thank you for contacting us.')
        await expect(frame).toHaveCount(0)
      }
      await page.keyboard.press('Escape')
    }
  })
}
