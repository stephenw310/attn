import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-inbox.json' })

test('shows inspectable recipients and collapses plain-text signatures and quotes', async ({ page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await page.keyboard.press('Enter')
  const cards = page.getByTestId('message-card')
  await expect(cards).toHaveCount(2)
  const contentWidth = await page
    .getByTestId('conversation-content')
    .evaluate((element) => element.getBoundingClientRect().width)
  expect(contentWidth).toBeGreaterThan(720)

  const firstSummary = cards.first().getByTestId('recipient-summary')
  await expect(cards.first()).toHaveAttribute('data-collapsed', 'true')
  await expect(firstSummary).toHaveCount(0)
  const olderToggle = cards.first().getByTestId('older-message-toggle')
  await expect(olderToggle).toHaveAttribute('aria-expanded', 'false')
  await olderToggle.click()
  await expect(cards.first()).toHaveAttribute('data-collapsed', 'false')
  await expect(firstSummary).toHaveText(/to me, Priya · cc Daniel/)
  await firstSummary.click()
  const details = cards.first().getByTestId('recipient-details')
  await expect(details).toContainText('seed@attn.test')
  await expect(details).toContainText('priya@example.com')
  await expect(details).toContainText('daniel@example.com')
  await expect(details).toContainText('maya+roadmap@example.com')
  await expect(details).toContainText('Date')
  const timezone = new Intl.DateTimeFormat(undefined, { timeZoneName: 'short' })
    .formatToParts(new Date(1_754_800_000_000))
    .find((part) => part.type === 'timeZoneName')?.value
  expect(timezone).toBeTruthy()
  await expect(details).toContainText(timezone ?? '')
  await expect(cards.first()).toHaveAttribute('data-collapsed', 'false')
  const headerWidth = await cards
    .first()
    .getByTestId('message-header')
    .evaluate((element) => {
      return element.getBoundingClientRect().width
    })
  const detailsWidth = await details.evaluate((element) => element.getBoundingClientRect().width)
  expect(Math.abs(headerWidth - detailsWidth)).toBeLessThan(1)
  await cards.first().getByTestId('older-message-toggle').click()
  await expect(cards.first()).toHaveAttribute('data-collapsed', 'true')
  await expect(cards.first().getByTestId('plain-text-body')).toHaveCount(0)
  await page.keyboard.press('j')
  await expect(page.getByTestId('conversation-subject')).toHaveText('Your receipt')
  await page.keyboard.press('k')
  await expect(page.getByTestId('conversation-subject')).toHaveText('Q3 roadmap review')

  const lastCard = cards.last()
  await expect(lastCard.getByTestId('plain-text-visible')).toHaveText(
    'I added the launch milestones and owner notes.'
  )
  await lastCard.getByTestId('message-header').click({ position: { x: 300, y: 8 } })
  await expect(lastCard).toHaveAttribute('data-collapsed', 'true')
  await expect(lastCard.getByTestId('plain-text-body')).toHaveCount(0)
  await lastCard.getByTestId('older-message-toggle').click()
  await expect(lastCard).toHaveAttribute('data-collapsed', 'false')
  const trimToggle = lastCard.getByTestId('mail-trim-toggle')
  await expect(trimToggle).toHaveAttribute('aria-expanded', 'false')
  await expect(trimToggle).toHaveText('...')
  await expect(trimToggle).toHaveCSS('border-top-width', '0px')
  expect(
    await trimToggle.evaluate((element) => {
      return element.closest('[data-testid="plain-text-body"]') !== null
    })
  ).toBe(true)
  const collapsedToggleY = await trimToggle.evaluate((element) => element.getBoundingClientRect().y)
  await trimToggle.click()
  await expect(lastCard.getByTestId('plain-text-trimmed')).toContainText('Maya Lin')
  await expect(lastCard.getByTestId('plain-text-trimmed')).toContainText('On Friday, Priya wrote:')
  expect(
    Math.abs((await trimToggle.evaluate((element) => element.getBoundingClientRect().y)) - collapsedToggleY)
  ).toBeLessThan(1)
  await trimToggle.click()
  await expect(lastCard.getByTestId('plain-text-trimmed')).toHaveCount(0)
  await expect(lastCard.getByTestId('plain-text-visible')).toHaveText(
    'I added the launch milestones and owner notes.'
  )
  await page.keyboard.press('j')
  await expect(page.getByTestId('conversation-subject')).toHaveText('Your receipt')
})

test('shows attachment metadata and explains offline downloads', async ({ page }) => {
  await page.getByTestId('thread-row').filter({ hasText: 'Your receipt' }).click()
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  const attachment = page.getByTestId('attachment-chip')
  await expect(attachment).toContainText('receipt.pdf')
  await expect(attachment).toContainText('24 KB')
  const content = page.getByTestId('message-content')
  await expect(content).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  const frame = page.getByTestId('html-body-frame')
  const frameBody = page.frameLocator('[data-testid="html-body-frame"]')
  await expect(frameBody.locator('body')).toHaveCSS('padding-left', '12px')
  await expect(frameBody.locator('#plain-html-copy')).toContainText('Your order total was $24.00.')
  expect(
    await frame.evaluate((element) => {
      const iframe = element as HTMLIFrameElement
      const marker = iframe.contentDocument?.querySelector<HTMLElement>('[data-attn-trim-start]')
      const prefix = iframe.contentDocument?.querySelector<HTMLElement>('.gmail_signature_prefix')
      return marker && prefix
        ? Math.abs(marker.getBoundingClientRect().bottom - iframe.clientHeight) < 1 &&
            prefix.getBoundingClientRect().top >= iframe.clientHeight
        : false
    })
  ).toBe(true)
  const toggle = page.getByTestId('mail-trim-toggle')
  const frameLeft = await frame.evaluate((element) => element.getBoundingClientRect().left)
  const toggleLeft = await toggle.evaluate((element) => element.getBoundingClientRect().left)
  const attachmentLeft = await attachment.evaluate((element) => element.getBoundingClientRect().left)
  expect(Math.abs(toggleLeft - frameLeft - 12)).toBeLessThan(1)
  expect(Math.abs(attachmentLeft - frameLeft - 12)).toBeLessThan(1)
  expect(
    await attachment.evaluate((element) => element.closest('[data-testid="message-content"]') !== null)
  ).toBe(true)
  await attachment.click()
  await expect(page.getByTestId('toast')).toHaveText('Attachments download when signed in')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('conversation-view')).toHaveCount(0)
})

test('keeps HTML fallbacks readable and never collapses an all-quote message', async ({ page }) => {
  await page.getByTestId('thread-row').filter({ hasText: 'Lunch next week' }).click()
  const quoteFrame = page.getByTestId('html-body-frame')
  await expect(quoteFrame).toBeVisible()
  await expect(page.frameLocator('[data-testid="html-body-frame"]').locator('#all-quote')).toHaveText(
    'Would noon on Tuesday work?'
  )
  await expect(page.getByTestId('mail-trim-toggle')).toHaveCount(0)

  await page.keyboard.press('Escape')
  await page.getByTestId('thread-row').filter({ hasText: 'Flight options' }).click()
  await expect(page.getByTestId('html-body-frame')).toHaveCount(0)
  const fallback = page.getByTestId('plain-text-body')
  await expect(fallback).toHaveText('I found three routes for the conference.')
  await expect(fallback).toHaveCSS('color', 'rgb(32, 33, 36)')
  await expect(fallback).toHaveCSS('padding-left', '12px')
})

test('collapses sanitized HTML quote and signature blocks behind an expander', async ({ page }) => {
  const pixel = Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64')
  for (const host of ['remote.attn.test', 'handler.attn.test']) {
    await page.route(`https://${host}/**`, (route) =>
      route.fulfill({ contentType: 'image/gif', body: pixel })
    )
  }
  await page.getByTestId('thread-row').filter({ hasText: 'This week in focus' }).click()
  const frameBody = page.frameLocator('[data-testid="html-body-frame"]')
  const toggle = page.getByTestId('mail-trim-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(toggle).toHaveText('...')
  await expect(toggle).toHaveCSS('font-size', '14px')
  await expect(toggle).toHaveCSS('letter-spacing', 'normal')
  const frame = page.getByTestId('html-body-frame')
  const conversationScroll = page.getByTestId('conversation-scroll')
  const conversationContent = page.getByTestId('conversation-content')
  await expect(conversationScroll).toHaveCSS('scrollbar-gutter', 'stable')
  const collapsedViewportBox = await conversationScroll.boundingBox()
  expect(collapsedViewportBox).not.toBeNull()
  const collapsedContentBox = await conversationContent.boundingBox()
  expect(collapsedContentBox).not.toBeNull()
  const collapsedHeight = await frame.evaluate((element) => element.clientHeight)
  expect(collapsedHeight).toBeLessThan(1000)
  const collapsedToggleY = await toggle.evaluate((element) => element.getBoundingClientRect().y)
  expect(
    await frame.evaluate((element) => {
      const iframe = element as HTMLIFrameElement
      const marker = iframe.contentDocument?.querySelector<HTMLElement>('[data-attn-trim-start]')
      const signature = iframe.contentDocument?.querySelector<HTMLElement>('.gmail_signature')
      return marker && signature
        ? Math.abs(marker.getBoundingClientRect().height - 28) < 1 &&
            signature.getBoundingClientRect().top >= marker.getBoundingClientRect().bottom &&
            Math.abs(iframe.clientHeight - marker.getBoundingClientRect().bottom - 16) < 1
        : false
    })
  ).toBe(true)
  await frame.evaluate((element) => element.setAttribute('data-trim-stability', 'original'))

  // Tab remains native app focus navigation: it moves from the reading
  // surface through header controls and into links inside the mail frame
  // without requiring a click in the message body.
  await conversationScroll.focus()
  await page.keyboard.press('Tab')
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid')))
    .toBe('older-message-toggle')
  await page.keyboard.press('Tab')
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid')))
    .toBe('recipient-summary')
  // The visually earlier ellipsis also comes before iframe links in keyboard
  // order, so a collapsed body cannot jump straight into an oddly clipped link.
  await page.keyboard.press('Tab')
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid')))
    .toBe('mail-trim-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'true')
  await page.keyboard.press('Tab')
  await expect
    .poll(() =>
      frame.evaluate((element) => {
        const iframe = element as HTMLIFrameElement
        return iframe.contentDocument?.activeElement?.id
      })
    )
    .toBe('schemeless-link')
  await expect(frameBody.locator('.gmail_signature')).toBeVisible()
  await expect(frameBody.locator('.gmail_quote')).toBeVisible()
  await expect(frame).toHaveAttribute('data-trim-stability', 'original')
  await expect.poll(() => frame.evaluate((element) => element.clientHeight)).toBeGreaterThan(collapsedHeight)
  const expandedHeight = await frame.evaluate((element) => element.clientHeight)
  const expandedViewportBox = await conversationScroll.boundingBox()
  expect(expandedViewportBox).not.toBeNull()
  const expandedContentBox = await conversationContent.boundingBox()
  expect(expandedContentBox).not.toBeNull()
  expect(expandedHeight).toBeGreaterThan(collapsedHeight)
  expect(Math.abs((expandedViewportBox?.width ?? 0) - (collapsedViewportBox?.width ?? 0))).toBeLessThan(1)
  expect(Math.abs((expandedViewportBox?.height ?? 0) - (collapsedViewportBox?.height ?? 0))).toBeLessThan(1)
  expect(await conversationScroll.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(
    true
  )
  expect(Math.abs((expandedContentBox?.x ?? 0) - (collapsedContentBox?.x ?? 0))).toBeLessThan(1)
  expect(Math.abs((expandedContentBox?.width ?? 0) - (collapsedContentBox?.width ?? 0))).toBeLessThan(1)
  expect(
    Math.abs((await toggle.evaluate((element) => element.getBoundingClientRect().y)) - collapsedToggleY)
  ).toBeLessThan(1)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(() => frame.evaluate((element) => element.clientHeight)).toBe(collapsedHeight)
  expect(
    Math.abs((await toggle.evaluate((element) => element.getBoundingClientRect().y)) - collapsedToggleY)
  ).toBeLessThan(1)

  // Shift+Tab returns from the first mail link to the ellipsis control. Escape
  // remains Back/Close from that focused button instead of becoming inert.
  await page.keyboard.press('Shift+Tab')
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid')))
    .toBe('mail-trim-toggle')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('conversation-pane')).toHaveCount(0)
})
