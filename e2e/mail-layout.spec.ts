import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { ComposerPage } from './composer'
import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-mail-layout.json' })

test('separates native, centered, and full-bleed sender canvases', async ({ page }, testInfo) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(11)

  await page.getByTestId('thread-row').filter({ hasText: 'Plain layout' }).click()
  await expect(page.getByTestId('html-body-frame')).toHaveCount(0)
  await expect(page.getByTestId('message-card')).toHaveCSS('padding-left', '20px')
  await expect(page.getByTestId('message-card')).toHaveCSS('padding-right', '20px')
  await expect
    .poll(() =>
      page.getByTestId('conversation-content').evaluate((content) => {
        const expectedWidth = Math.min(896, Math.max(576, window.innerWidth * 0.576))
        return Math.abs(content.getBoundingClientRect().width - expectedWidth)
      })
    )
    .toBeLessThan(1)

  await page.keyboard.press('Escape')
  await page.getByTestId('thread-row').filter({ hasText: 'Centered newsletter' }).click()
  await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-surface', 'light')
  await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-layout', 'centered')
  const centeredBody = page.frameLocator('[data-testid="html-body-frame"]').locator('body')
  await expect(centeredBody).toHaveCSS('padding-left', '0px')
  await expect(centeredBody).toHaveCSS('padding-right', '0px')
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
  await expect(wrapperBody).toHaveCSS('padding-left', '0px')
  await expect(wrapperBody).toHaveCSS('padding-right', '0px')

  await page.keyboard.press('Escape')
  await page.getByTestId('thread-row').filter({ hasText: 'Color-coded reply' }).click()
  await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-surface', 'native')
  await page.getByTestId('mail-trim-toggle').click()
  const coloredReply = page.frameLocator('[data-testid="html-body-frame"]')
  await expect(coloredReply.locator('#quoted-question')).toHaveCSS('color', 'rgb(184, 178, 165)')
  await expect(coloredReply.locator('#quoted-answer')).toHaveCSS('color', 'rgb(56, 123, 223)')
  await expect(coloredReply.locator('#quoted-answer-dark')).toHaveCSS('color', 'rgb(79, 125, 196)')
  const coloredReplyPath = join(dir, 'colored-reply.png')
  await page.screenshot({ path: coloredReplyPath })
  await testInfo.attach('colored reply', { path: coloredReplyPath, contentType: 'image/png' })
})

test('keeps sender canvases solid and removes native line backgrounds in light themes', async ({
  page
}, testInfo) => {
  await page.emulateMedia({ colorScheme: 'light' })
  await page.getByTestId('account-menu').getByRole('button').first().click()
  await page.getByTestId('theme-picker').selectOption('dispatch-light')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dispatch-light')
  await page.keyboard.press('Escape')

  await page.getByTestId('thread-row').filter({ hasText: 'Centered newsletter' }).click()
  await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-surface', 'light')
  await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-layout', 'centered')
  await expect(page.getByTestId('message-content')).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  await expect(page.getByTestId('message-content')).toHaveCSS('border-radius', '0px')
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

  await page.keyboard.press('Escape')
  await page.getByTestId('thread-row').filter({ hasText: 'Print confirmation canvas' }).click()
  await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-surface', 'light')
  await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-layout', 'padded')
  const printConfirmation = page.frameLocator('[data-testid="html-body-frame"]')
  await expect(printConfirmation.locator('#print-canvas')).toHaveCSS('background-color', 'rgb(236, 240, 241)')
  await expect(printConfirmation.locator('#print-summary')).toHaveCSS('background-color', 'rgb(44, 61, 79)')
  await expect(printConfirmation.locator('#print-summary')).toHaveCSS('color', 'rgb(255, 255, 255)')

  const dir = join(__dirname, '.artifacts')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'mail-layout-light.png')
  await page.screenshot({ path })
  await testInfo.attach('light mail layout', { path, contentType: 'image/png' })

  await page.keyboard.press('Escape')
  await page.getByTestId('thread-row').filter({ hasText: 'Negated dark canvas' }).click()
  await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-surface', 'light')
  await expect(
    page.frameLocator('[data-testid="html-body-frame"]').locator('#negated-dark-canvas')
  ).toHaveCSS('background-color', 'rgb(255, 243, 214)')

  await page.keyboard.press('Escape')
  await page.getByTestId('thread-row').filter({ hasText: 'Neutral line backgrounds' }).click()
  await expect(page.getByTestId('conversation-subject')).toHaveText('Neutral line backgrounds')
  await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-surface', 'native')
  const nativeMail = page.frameLocator('[data-testid="html-body-frame"]')
  await expect(nativeMail.locator('html')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(nativeMail.locator('#inline-white')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(nativeMail.locator('#styled-white')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(nativeMail.locator('#styled-white')).toHaveCSS('font-weight', '700')

  const neutralPath = join(dir, 'neutral-backgrounds-light.png')
  await page.screenshot({ path: neutralPath })
  await testInfo.attach('neutral light mail backgrounds', { path: neutralPath, contentType: 'image/png' })
})

for (const appearance of ['light', 'dark'] as const) {
  test(`normalizes Apple Mail pasted backgrounds in the ${appearance} reader and reply preview`, async ({
    page
  }, testInfo) => {
    await page.getByTestId('account-menu').getByRole('button').first().click()
    await page.getByTestId('theme-picker').selectOption(`dispatch-${appearance}`)
    await expect(page.locator('html')).toHaveAttribute('data-theme', `dispatch-${appearance}`)
    await page.keyboard.press('Escape')
    await page.getByTestId('thread-row').filter({ hasText: 'Apple Mail pasted backgrounds' }).click()
    await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-surface', 'native')
    const frame = page.frameLocator('[data-testid="html-body-frame"]')
    for (const id of ['apple-greeting', 'apple-spacer', 'apple-question', 'apple-close']) {
      await expect(frame.locator(`#${id}`)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      await expect(frame.locator(`#${id} > span`)).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    }
    await expect(frame.locator('#apple-question')).toHaveCSS(
      'color',
      appearance === 'light' ? 'rgb(32, 33, 36)' : 'rgb(233, 228, 216)'
    )
    await expect(frame.locator('#apple-question')).toContainText('Can we schedule a call?')
    if (appearance === 'dark') {
      await page.getByTestId('mail-original-toggle').click()
      await expect(frame.locator('#apple-question')).toHaveCSS('background-color', 'rgb(58, 58, 60)')
      await expect(frame.locator('#apple-question > span')).toHaveCSS(
        'background-color',
        'rgb(255, 255, 255)'
      )
      await page.getByTestId('mail-original-toggle').click()
      await expect(frame.locator('#apple-question')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    }
    const dir = join(__dirname, '.artifacts')
    mkdirSync(dir, { recursive: true })
    const path = join(dir, `apple-mail-backgrounds-${appearance}.png`)
    await page.screenshot({ path })
    await testInfo.attach(`Apple Mail backgrounds ${appearance}`, { path, contentType: 'image/png' })

    const composer = new ComposerPage(page)
    await composer.openReply()
    await page.getByTestId('composer-quote-toggle').click()
    const quote = page.frameLocator('[data-testid="composer-quote"]')
    // The outgoing sanitizer intentionally removes sender IDs.
    const question = quote.getByText('Thanks for the update. Can we schedule a call?', { exact: true })
    await expect(question).toBeVisible()
    await expect(question).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(question.locator('..')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    // The display cleanup must not rewrite the original quote that will be sent.
    const draftId = await composer.root.getAttribute('data-draft-id')
    await expect
      .poll(async () =>
        page.evaluate(async (id) => (await window.attn.draft.get(id ?? ''))?.quoteHtml, draftId)
      )
      .toContain('background-color: rgb(58, 58, 60)')
    const quotePath = join(dir, `apple-mail-quote-${appearance}.png`)
    await page.screenshot({ path: quotePath })
    await testInfo.attach(`Apple Mail quote ${appearance}`, { path: quotePath, contentType: 'image/png' })
  })
}
