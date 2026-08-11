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
  await expect(firstSummary).toHaveText(/to me, Priya · cc Daniel/)
  await firstSummary.click()
  const details = cards.first().getByTestId('recipient-details')
  await expect(details).toContainText('seed@attn.test')
  await expect(details).toContainText('priya@example.com')
  await expect(details).toContainText('daniel@example.com')
  await expect(details).toContainText('maya+roadmap@example.com')
  await expect(details).toContainText('Date')
  const headerWidth = await cards
    .first()
    .getByTestId('message-header')
    .evaluate((element) => {
      return element.getBoundingClientRect().width
    })
  const detailsWidth = await details.evaluate((element) => element.getBoundingClientRect().width)
  expect(Math.abs(headerWidth - detailsWidth)).toBeLessThan(1)

  const lastCard = cards.last()
  await expect(lastCard.getByTestId('plain-text-visible')).toHaveText(
    'I added the launch milestones and owner notes.'
  )
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
})

test('shows attachment metadata and explains offline downloads', async ({ page }) => {
  await page.getByTestId('thread-row').filter({ hasText: 'Your receipt' }).click()
  await expect(page.getByTestId('conversation-pane')).toBeVisible()
  const attachment = page.getByTestId('attachment-chip')
  await expect(attachment).toContainText('receipt.pdf')
  await expect(attachment).toContainText('24 KB')
  const content = page.getByTestId('message-content')
  await expect(content).toHaveCSS('background-color', 'rgb(255, 255, 255)')
  expect(
    await attachment.evaluate((element) => element.closest('[data-testid="message-content"]') !== null)
  ).toBe(true)
  await attachment.click()
  await expect(page.getByTestId('toast')).toHaveText('Attachments download when signed in')
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
  const collapsedHeight = await frame.evaluate((element) => element.clientHeight)
  expect(collapsedHeight).toBeLessThan(1000)
  const collapsedToggleY = await toggle.evaluate((element) => element.getBoundingClientRect().y)
  expect(
    await frame.evaluate((element) => {
      const iframe = element as HTMLIFrameElement
      const signature = iframe.contentDocument?.querySelector<HTMLElement>('.gmail_signature')
      return signature
        ? Math.abs(iframe.clientHeight - signature.getBoundingClientRect().top - 28 - 16) < 1
        : false
    })
  ).toBe(true)
  await frame.evaluate((element) => element.setAttribute('data-trim-stability', 'original'))
  await toggle.click()
  await expect(frameBody.locator('.gmail_signature')).toBeVisible()
  await expect(frameBody.locator('.gmail_quote')).toBeVisible()
  await expect(frame).toHaveAttribute('data-trim-stability', 'original')
  await expect.poll(() => frame.evaluate((element) => element.clientHeight)).toBeGreaterThan(collapsedHeight)
  const expandedHeight = await frame.evaluate((element) => element.clientHeight)
  expect(expandedHeight).toBeGreaterThan(collapsedHeight)
  expect(
    Math.abs((await toggle.evaluate((element) => element.getBoundingClientRect().y)) - collapsedToggleY)
  ).toBeLessThan(1)
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-expanded', 'false')
  await expect.poll(() => frame.evaluate((element) => element.clientHeight)).toBe(collapsedHeight)
  expect(
    Math.abs((await toggle.evaluate((element) => element.getBoundingClientRect().y)) - collapsedToggleY)
  ).toBeLessThan(1)
})
