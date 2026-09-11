import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-mail-layout.json' })

for (const appearance of ['light', 'dark'] as const) {
  test(`keeps a simple reply native above rich history in the ${appearance} reader`, async ({
    page
  }, testInfo) => {
    let imageRequests = 0
    await page.route('https://mixed.attn.test/**', async (route) => {
      imageRequests += 1
      await route.fulfill({
        contentType: 'image/gif',
        body: Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64')
      })
    })
    await page.getByTestId('account-menu').getByRole('button').first().click()
    await page.getByTestId('theme-picker').selectOption(`dispatch-${appearance}`)
    await page.keyboard.press('Escape')
    await page.getByTestId('thread-row').filter({ hasText: 'Simple reply with rich history' }).click()

    const authored = page.getByTestId('mail-authored-section')
    const quote = page.getByTestId('mail-quoted-section')
    const authoredFrame = authored.getByTestId('html-body-frame')
    const quoteFrame = quote.getByTestId('html-body-frame')
    const authoredBody = authored.frameLocator('iframe')
    const quoteBody = quote.frameLocator('iframe')
    const toggle = page.getByTestId('mail-trim-toggle')
    await expect(authoredFrame).toBeVisible()
    await expect(page.getByTestId('message-card')).toHaveCSS('padding-left', '12px')
    await expect(page.getByTestId('message-card')).toHaveCSS('padding-right', '12px')
    await expect(page.getByTestId('message-content')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(authored.getByTestId('html-body-container')).toHaveAttribute('data-surface', 'native')
    await expect(authoredBody.locator('body')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
    await expect(authoredBody.locator('#current-answer')).toContainText('configuration changes')
    await expect(authoredBody.locator('#current-answer')).toHaveCSS(
      'color',
      appearance === 'light' ? 'rgb(32, 33, 36)' : 'rgb(233, 234, 238)'
    )
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(quote).toBeHidden()
    await expect(page.getByTestId('html-body-frame')).toHaveCount(2)
    await expect(quoteBody.locator('#history-cid')).toHaveAttribute('src', /^data:image\/gif;base64,/)
    await expect(quoteBody.locator('#history-remote')).not.toHaveAttribute('data-attn-image-pending')
    await expect.poll(() => imageRequests).toBe(1)
    for (const frame of [authoredFrame, quoteFrame]) {
      await expect(frame).toHaveAttribute('data-load-count', '1')
      await expect(frame).toHaveAttribute(
        'sandbox',
        'allow-same-origin allow-popups allow-popups-to-escape-sandbox'
      )
      await frame.evaluate((element) => {
        const doc = (element as HTMLIFrameElement).contentDocument
        if (doc) doc.documentElement.dataset.originalDocument = 'true'
      })
    }
    for (const frame of [authoredBody, quoteBody]) {
      await expect(frame.locator('script, [onclick], [onload], [data-attn-trim-start]')).toHaveCount(0)
      await expect(frame.locator('body')).not.toHaveAttribute('data-script-ran')
    }
    const authoredHeight = await authoredFrame.evaluate((element) => element.clientHeight)
    const dir = join(__dirname, '.artifacts')
    mkdirSync(dir, { recursive: true })
    const collapsedPath = join(dir, `mixed-reply-${appearance}.png`)
    await page.screenshot({ path: collapsedPath })
    await testInfo.attach(`simple reply ${appearance}`, { path: collapsedPath, contentType: 'image/png' })

    await toggle.click()
    await expect(quoteFrame).toBeVisible()
    await expect(quote.getByTestId('html-body-container')).toHaveAttribute('data-surface', 'light')
    await expect(quoteBody.locator('#history-canvas')).toHaveCSS('background-color', 'rgb(229, 237, 248)')
    await expect(quoteBody.locator('#history-heading')).toHaveCSS('background-color', 'rgb(36, 76, 112)')
    await expect(quoteBody.locator('#history-heading')).toHaveCSS('padding-left', '24px')
    await expect
      .poll(() =>
        quoteFrame.evaluate((element) => {
          const frame = element as HTMLIFrameElement
          return (
            frame.clientHeight > 450 &&
            (frame.contentDocument?.documentElement.scrollHeight ?? 0) <= frame.clientHeight + 1
          )
        })
      )
      .toBe(true)
    await expect.poll(() => authoredFrame.evaluate((element) => element.clientHeight)).toBe(authoredHeight)
    const expandedPath = join(dir, `mixed-quote-${appearance}.png`)
    await page.screenshot({ path: expandedPath })
    await testInfo.attach(`rich history ${appearance}`, { path: expandedPath, contentType: 'image/png' })

    await toggle.click()
    await expect(quote).toBeHidden()
    // Keyboard reveal must retain both documents and visit authored and quoted links in order.
    await toggle.focus()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('Tab')
    await expect(authoredBody.locator('#answer-link')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(quoteBody.locator('#history-link')).toBeFocused()
    for (const frame of [authoredFrame, quoteFrame]) {
      await expect(frame).toHaveAttribute('data-load-count', '1')
      expect(
        await frame.evaluate(
          (element) =>
            (element as HTMLIFrameElement).contentDocument?.documentElement.dataset.originalDocument
        )
      ).toBe('true')
    }
    expect(imageRequests).toBe(1)

    if (appearance === 'dark') {
      await page.getByTestId('mail-original-toggle').click()
      await expect(page.getByTestId('mixed-mail-body')).toHaveCount(0)
      await expect(page.getByTestId('html-body-frame')).toHaveCount(1)
      const original = page.frameLocator('[data-testid="html-body-frame"]')
      await expect(original.locator('#current-answer')).toBeVisible()
      await expect(original.locator('#history-canvas')).toHaveCSS('background-color', 'rgb(229, 237, 248)')
      await page.getByTestId('mail-original-toggle').click()
      await expect(authoredFrame).toBeVisible()
      await expect(quoteFrame).toBeVisible()
      await quoteBody.locator('#history-link').focus()
    }
    // Reader shortcuts still cross the quoted document's sandbox boundary.
    await page.keyboard.press('Escape')
    await expect(page.getByTestId('conversation-view')).toHaveCount(0)
  })
}
