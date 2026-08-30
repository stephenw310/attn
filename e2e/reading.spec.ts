import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-inbox.json' })

test('moves between messages with N and P and toggles the active message with O', async ({
  page
}, testInfo) => {
  await page.getByTestId('thread-row').filter({ hasText: 'Q3 roadmap review' }).click()
  const messages = page.getByTestId('conversation-message')
  const cards = page.getByTestId('message-card')
  await expect(messages).toHaveCount(3)
  await expect(messages.nth(1)).toHaveAttribute('data-active-message', 'true')
  await expect(cards.first()).toHaveAttribute('data-collapsed', 'true')

  await page.keyboard.press('p')
  await expect(messages.first()).toHaveAttribute('data-active-message', 'true')
  await expect(cards.first()).toHaveAttribute('data-collapsed', 'true')
  await expect(messages.first()).toHaveCSS('box-shadow', 'none')
  const artifactDirectory = join(__dirname, '.artifacts')
  mkdirSync(artifactDirectory, { recursive: true })
  const readerControlsPath = join(artifactDirectory, 'reader-controls.png')
  await page.screenshot({ path: readerControlsPath })
  await testInfo.attach('reader-controls', { path: readerControlsPath, contentType: 'image/png' })
  await page.keyboard.press('o')
  await expect(cards.first()).toHaveAttribute('data-collapsed', 'false')

  await page.keyboard.press('n')
  await expect(messages.nth(1)).toHaveAttribute('data-active-message', 'true')
  await page.keyboard.press('o')
  await expect(cards.last()).toHaveAttribute('data-collapsed', 'true')
})

test('invalidates viewed conversation data when local mail changes', async ({ app, page }) => {
  await page.getByTestId('thread-row').filter({ hasText: 'Q3 roadmap review' }).click()
  await expect(page.getByTestId('plain-text-visible').last()).toContainText(
    'I added the launch milestones and owner notes.'
  )

  await app.evaluate(
    ({ ipcMain }, { channel, messageId, bodyText }) =>
      new Promise<void>((resolve, reject) => {
        ipcMain.emit(channel, {}, messageId, bodyText, (error?: string) => {
          if (error) reject(new Error(error))
          else resolve()
        })
      }),
    {
      channel: TEST_CHANNELS.updateMessageBody,
      messageId: 'm-roadmap-2',
      bodyText: 'A newly synced reply is now visible.'
    }
  )

  await expect(page.getByTestId('message-card').last()).toContainText('A newly synced reply is now visible.')
})

test('clears the previous conversation while an uncached thread loads', async ({ app, page }) => {
  await page.getByTestId('thread-row').filter({ hasText: 'Q3 roadmap review' }).click()
  await expect(page.getByTestId('plain-text-visible').last()).toContainText('launch milestones')
  await page.keyboard.press('Escape')

  await app.evaluate(
    ({ ipcMain }, { channel, threadId, delayMs }) => ipcMain.emit(channel, {}, threadId, delayMs),
    { channel: TEST_CHANNELS.delayConversation, threadId: 't-weekly', delayMs: 500 }
  )
  await page.getByTestId('thread-row').filter({ hasText: 'This week in focus' }).click()

  await expect(page.getByTestId('conversation-subject')).toHaveText('This week in focus')
  await expect(page.getByTestId('conversation-loading')).toBeVisible()
  await expect(page.getByTestId('conversation-content')).toHaveCount(0)
  await expect(page.frameLocator('[data-testid="html-body-frame"]').locator('#viewport-hero')).toBeVisible()
})

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
  await expect(content).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  const frame = page.getByTestId('html-body-frame')
  const frameBody = page.frameLocator('[data-testid="html-body-frame"]')
  await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-surface', 'native')
  await expect(frameBody.locator('body')).toHaveCSS('padding-left', '0px')
  await expect(frameBody.locator('body')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(frameBody.locator('body')).toHaveCSS('color', 'rgb(233, 234, 238)')
  await expect(frameBody.locator('#plain-html-copy')).toContainText('Your order total was $24.00.')
  await expect(frameBody.locator('#plain-export-styles')).toHaveCount(0)
  await expect(frameBody.locator('#plain-layout')).not.toHaveAttribute('bgcolor')
  await expect(frameBody.locator('#plain-layout')).toHaveAttribute('width', '100%')
  await expect(frameBody.locator('#plain-html-copy').locator('xpath=ancestor::font')).toHaveAttribute(
    'face',
    'garamond, times new roman, serif'
  )
  await expect(frameBody.locator('#plain-inline-image')).toHaveCount(1)
  const generatedLink = frameBody.getByRole('link', {
    name: 'https://northstar.test/orders/24.pdf'
  })
  await expect(generatedLink).toHaveAttribute('href', 'https://northstar.test/orders/24.pdf')
  await expect(generatedLink).toHaveAttribute('target', '_blank')
  await expect(generatedLink).toHaveCSS('color', 'rgb(96, 165, 250)')
  await expect
    .poll(() =>
      frame.evaluate((element) => {
        const iframe = element as HTMLIFrameElement
        const marker = iframe.contentDocument?.querySelector<HTMLElement>('[data-attn-trim-start]')
        const decorated = iframe.contentDocument?.querySelector<HTMLElement>('#decorated-signature-copy')
        const prefix = iframe.contentDocument?.querySelector<HTMLElement>('.gmail_signature_prefix')
        return marker && decorated && prefix
          ? Math.abs(marker.getBoundingClientRect().bottom - iframe.clientHeight) < 1 &&
              decorated.getBoundingClientRect().top >= iframe.clientHeight - 1 &&
              prefix.getBoundingClientRect().top >= iframe.clientHeight - 1
          : false
      })
    )
    .toBe(true)
  const toggle = page.getByTestId('mail-trim-toggle')
  const frameLeft = await frame.evaluate((element) => element.getBoundingClientRect().left)
  const toggleLeft = await toggle.evaluate((element) => element.getBoundingClientRect().left)
  const attachmentLeft = await attachment.evaluate((element) => element.getBoundingClientRect().left)
  expect(Math.abs(toggleLeft - frameLeft)).toBeLessThan(1)
  expect(Math.abs(attachmentLeft - frameLeft)).toBeLessThan(1)
  await toggle.click()
  await expect(frameBody.locator('#decorated-signature-copy')).toContainText('-- The Northstar Books Team --')
  await expect(frameBody.locator('#signature-disclaimer')).toContainText('Confidential order information.')
  await expect(frameBody.locator('#native-signature-copy')).toHaveCSS('color', 'rgb(233, 234, 238)')
  await expect(frameBody.locator('#native-signature-link')).toHaveCSS('color', 'rgb(96, 165, 250)')
  expect(
    await attachment.evaluate((element) => element.closest('[data-testid="message-content"]') !== null)
  ).toBe(true)
  await attachment.click()
  await expect(page.getByTestId('toast')).toHaveText('Attachments download when signed in')
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('conversation-view')).toHaveCount(0)
})

test('linkifies plain-text mail and collapses decorated signature lines', async ({ page }) => {
  await page.getByTestId('thread-row').filter({ hasText: 'Research summary' }).click()
  const visible = page.getByTestId('plain-text-visible')
  await expect(visible).toContainText('The latest usability findings are promising.')
  const generatedLink = visible.getByRole('link', {
    name: 'https://research.example/findings'
  })
  await expect(generatedLink).toHaveAttribute('href', 'https://research.example/findings')
  await expect(generatedLink).toHaveAttribute('target', '_blank')
  await expect(generatedLink).toHaveCSS('color', 'rgb(96, 165, 250)')

  const toggle = page.getByTestId('mail-trim-toggle')
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByTestId('plain-text-trimmed')).toHaveCount(0)
  await toggle.click()
  await expect(page.getByTestId('plain-text-trimmed')).toContainText('-- The Research Team --')
  await expect(page.getByTestId('plain-text-trimmed')).toContainText('Confidential research notes.')
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
  await expect(fallback).toHaveCSS('color', 'rgb(233, 234, 238)')
  await expect(fallback).toHaveCSS('padding-left', '0px')
})

test('collapses sanitized HTML quote and signature blocks behind an expander', async ({ page }) => {
  const pixel = Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64')
  const imageHosts = ['remote.attn.test', 'handler.attn.test']
  for (const host of imageHosts) {
    await page.route(`https://${host}/**`, (route) =>
      route.fulfill({ contentType: 'image/gif', body: pixel })
    )
  }
  const imageResponses = Promise.all(
    imageHosts.map((host) => page.waitForResponse((response) => new URL(response.url()).hostname === host))
  )
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
  // The frame starts at 1px, then ResizeObserver remeasures as remote images
  // settle. Capture the baseline only after both routed images load and two
  // consecutive measurements agree.
  await imageResponses
  let previousHeight = 0
  await expect
    .poll(async () => {
      const height = await frame.evaluate((element) => element.clientHeight)
      const settled = height > 1 && height === previousHeight
      previousHeight = height
      return settled
    })
    .toBe(true)
  const collapsedHeight = previousHeight
  expect(collapsedHeight).toBeLessThan(1000)
  const collapsedToggleY = await toggle.evaluate((element) => element.getBoundingClientRect().y)
  expect(
    await frame.evaluate((element) => {
      const iframe = element as HTMLIFrameElement
      const marker = iframe.contentDocument?.querySelector<HTMLElement>('[data-attn-trim-start]')
      const signature = iframe.contentDocument?.querySelector<HTMLElement>('.gmail_signature')
      return marker && signature
        ? Math.abs(marker.getBoundingClientRect().height - 44) < 1 &&
            Math.abs(iframe.clientHeight - marker.getBoundingClientRect().bottom) < 1 &&
            signature.getBoundingClientRect().top >= iframe.clientHeight - 1
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
  await expect(page.getByTestId('conversation-view')).toHaveCount(0)
})
