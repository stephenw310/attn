import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-mail-layout.json' })

test('separates native, centered, and full-bleed sender canvases', async ({ page }, testInfo) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(7)

  await page.getByTestId('thread-row').filter({ hasText: 'Plain layout' }).click()
  await expect(page.getByTestId('html-body-frame')).toHaveCount(0)
  await expect(page.getByTestId('message-card')).toHaveCSS('padding-left', '20px')
  await expect(page.getByTestId('message-card')).toHaveCSS('padding-right', '20px')

  await page.keyboard.press('Escape')
  await page.getByTestId('thread-row').filter({ hasText: 'Centered newsletter' }).click()
  await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-surface', 'light')
  await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-layout', 'centered')
  const paddedBody = page.frameLocator('[data-testid="html-body-frame"]').locator('body')
  await expect(paddedBody).toHaveCSS('padding-left', '12px')
  await expect(paddedBody).toHaveCSS('padding-right', '12px')
  await expect
    .poll(() =>
      page
        .frameLocator('[data-testid="html-body-frame"]')
        .locator('#compact-card')
        .evaluate((canvas) => {
          const rect = canvas.getBoundingClientRect()
          return Math.abs(rect.left - (canvas.ownerDocument.documentElement.clientWidth - rect.right))
        })
    )
    .toBeLessThan(1)

  await page.keyboard.press('Escape')
  await page.getByTestId('thread-row').filter({ hasText: 'Full-bleed newsletter' }).click()
  await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-layout', 'full-bleed')
  const newsletter = page.frameLocator('[data-testid="html-body-frame"]')
  await expect(newsletter.locator('body')).toHaveCSS('padding-left', '0px')
  await expect(newsletter.locator('body')).toHaveCSS('padding-right', '0px')
  await expect
    .poll(() =>
      newsletter.locator('#newsletter-canvas').evaluate((canvas) => {
        const rect = canvas.getBoundingClientRect()
        return [
          Math.abs(Math.round(rect.left)),
          Math.abs(Math.round(canvas.ownerDocument.documentElement.clientWidth - rect.right))
        ]
      })
    )
    .toEqual([0, 0])

  const dir = join(__dirname, '.artifacts')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'mail-layout.png')
  await page.screenshot({ path })
  await testInfo.attach('mail layout', { path, contentType: 'image/png' })

  await page.keyboard.press('Escape')
  await page.getByTestId('thread-row').filter({ hasText: 'Sender-owned padding' }).click()
  await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-layout', 'full-bleed')
  await expect(page.frameLocator('[data-testid="html-body-frame"]').locator('body')).toHaveCSS(
    'padding-left',
    '31px'
  )

  await page.keyboard.press('Escape')
  await page.getByTestId('thread-row').filter({ hasText: 'Discarded wrapper canvas' }).click()
  await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-layout', 'padded')
  const wrapperBody = page.frameLocator('[data-testid="html-body-frame"]').locator('body')
  await expect(wrapperBody).toHaveCSS('padding-left', '12px')
  await expect(wrapperBody).toHaveCSS('padding-right', '12px')

  await page.keyboard.press('Escape')
  await page.getByTestId('thread-row').filter({ hasText: 'Color-coded reply' }).click()
  await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-surface', 'native')
  await page.getByTestId('mail-trim-toggle').click()
  const coloredReply = page.frameLocator('[data-testid="html-body-frame"]')
  await expect(coloredReply.locator('#quoted-question')).toHaveCSS('color', 'rgb(157, 162, 172)')
  await expect(coloredReply.locator('#quoted-answer')).toHaveCSS('color', 'rgb(56, 123, 223)')
  await expect(coloredReply.locator('#quoted-answer-dark')).toHaveCSS('color', 'rgb(79, 125, 196)')
  const coloredReplyPath = join(dir, 'colored-reply.png')
  await page.screenshot({ path: coloredReplyPath })
  await testInfo.attach('colored reply', { path: coloredReplyPath, contentType: 'image/png' })
})

test('keeps sender canvases solid and removes native line backgrounds in light themes', async ({
  page
}, testInfo) => {
  await page.getByTestId('account-menu').getByRole('button').first().click()
  await page.getByTestId('theme-picker').selectOption('dispatch-light')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dispatch-light')
  await page.keyboard.press('Escape')

  await page.getByTestId('thread-row').filter({ hasText: 'Centered newsletter' }).click()
  await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-surface', 'light')
  await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-layout', 'centered')
  await expect(page.getByTestId('message-content')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(page.getByTestId('html-body-container')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  const centeredNewsletter = page.frameLocator('[data-testid="html-body-frame"]')
  await expect(centeredNewsletter.locator('body')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect
    .poll(() =>
      centeredNewsletter.locator('#compact-card').evaluate((canvas) => {
        const rect = canvas.getBoundingClientRect()
        return Math.abs(rect.left - (canvas.ownerDocument.documentElement.clientWidth - rect.right))
      })
    )
    .toBeLessThan(1)

  const dir = join(__dirname, '.artifacts')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'mail-layout-light.png')
  await page.screenshot({ path })
  await testInfo.attach('light mail layout', { path, contentType: 'image/png' })

  await page.keyboard.press('Escape')
  await page.getByTestId('thread-row').filter({ hasText: 'Neutral line backgrounds' }).click()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Neutral line backgrounds')
  await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-surface', 'native')
  const nativeMail = page.frameLocator('[data-testid="html-body-frame"]')
  await expect(nativeMail.locator('#inline-white')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(nativeMail.locator('#styled-white')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(nativeMail.locator('#styled-white')).toHaveCSS('font-weight', '700')

  const neutralPath = join(dir, 'neutral-backgrounds-light.png')
  await page.screenshot({ path: neutralPath })
  await testInfo.attach('neutral light mail backgrounds', { path: neutralPath, contentType: 'image/png' })
})
