import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-inbox.json' })

test('sanitizes hostile HTML in a scriptless iframe and preserves plain text mail', async ({
  page
}, testInfo) => {
  let remoteImageRequested = false
  let handlerImageRequested = false
  await page.route('https://remote.attn.test/**', async (route) => {
    remoteImageRequested = true
    await route.fulfill({
      contentType: 'image/gif',
      body: Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64')
    })
  })
  await page.route('https://handler.attn.test/**', async (route) => {
    handlerImageRequested = true
    await route.fulfill({ contentType: 'image/gif', body: 'not an image' })
  })

  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  await page.getByTestId('thread-row').filter({ hasText: 'This week in focus' }).dblclick()

  const iframe = page.getByTestId('html-body-frame')
  await expect(iframe).toBeVisible()
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-testid')))
    .toBe('conversation-scroll')
  await expect(iframe).toHaveAttribute(
    'sandbox',
    'allow-same-origin allow-popups allow-popups-to-escape-sandbox'
  )

  const body = page.frameLocator('[data-testid="html-body-frame"]')
  await expect(body.locator('#styled-table')).toBeVisible()
  await expect(body.locator('#styled-table')).toHaveAttribute('style', /border-collapse/)
  await expect(body.locator('#mail-styles')).toHaveCount(1)
  await expect(body.locator('#stylesheet-styled')).toHaveCSS('color', 'rgb(12, 34, 56)')
  await expect(body.locator('#invite-details')).toContainText('Invite: roadmap review at 10:00')
  await expect(body.locator('#custom-card-copy')).toHaveText('Important custom-card content')
  await expect(body.locator('script')).toHaveCount(0)
  await expect(body.locator('[onerror]')).toHaveCount(0)
  await expect(body.locator('a[href^="javascript:"]')).toHaveCount(0)
  await expect(body.locator('form, input, button, select, textarea')).toHaveCount(0)
  await expect(body.locator('#self-link')).toHaveAttribute('target', '_blank')
  await expect(body.locator('#top-link')).toHaveAttribute('target', '_blank')
  await expect(body.locator('#remote-image')).toHaveAttribute('src', 'https://remote.attn.test/tracker.gif')
  await expect.poll(() => remoteImageRequested).toBe(true)
  await expect.poll(() => handlerImageRequested).toBe(true)

  for (const marker of ['data-script-ran', 'data-handler-ran', 'data-link-ran']) {
    expect(await body.locator('body').getAttribute(marker)).toBeNull()
    expect(await page.locator('body').getAttribute(marker)).toBeNull()
  }

  await page.getByTestId('mail-trim-toggle').click()
  await expect
    .poll(() =>
      iframe.evaluate((element) => {
        const frame = element as HTMLIFrameElement
        const scrollHeight = frame.contentDocument?.documentElement.scrollHeight ?? 0
        return frame.clientHeight > 2500 && scrollHeight <= frame.clientHeight + 1
      })
    )
    .toBe(true)
  await expect(body.locator('#viewport-hero')).toHaveCSS('min-height', '800px')
  await expect(body.locator('html')).toHaveCSS('overflow-x', 'auto')
  await expect(body.locator('html')).toHaveCSS('overflow-y', 'hidden')
  await expect
    .poll(() =>
      iframe.evaluate((element) => {
        const doc = (element as HTMLIFrameElement).contentDocument
        return doc ? doc.documentElement.scrollWidth > doc.documentElement.clientWidth : false
      })
    )
    .toBe(true)
  await expect
    .poll(() =>
      page.getByTestId('conversation-scroll').evaluate((element) => {
        return element.scrollHeight > element.clientHeight
      })
    )
    .toBe(true)
  const stableHeight = await iframe.evaluate((element) => element.clientHeight)
  await page.waitForTimeout(250)
  expect(await iframe.evaluate((element) => element.clientHeight)).toBe(stableHeight)

  await iframe.evaluate((element) => element.setAttribute('data-stability-marker', 'original'))
  await page.evaluate(async () => {
    await new Promise<void>((resolve) => {
      const off = window.attn.mail.onChanged(() => {
        off()
        window.setTimeout(resolve, 50)
      })
      void window.attn.mail.markReadOnOpen('t-weekly')
    })
  })
  await expect(iframe).toHaveAttribute('data-stability-marker', 'original')

  const selectedPosition = await page.getByTestId('conversation-position').textContent()
  await page.keyboard.press('ArrowDown')
  await expect
    .poll(() => page.getByTestId('conversation-scroll').evaluate((element) => element.scrollTop))
    .toBeGreaterThanOrEqual(120)
  await expect(page.getByTestId('conversation-position')).toHaveText(selectedPosition ?? '')

  expect(
    await page.evaluate(() => {
      const event = new KeyboardEvent('keydown', {
        key: 'ArrowDown',
        altKey: true,
        bubbles: true,
        cancelable: true
      })
      window.dispatchEvent(event)
      return event.defaultPrevented
    })
  ).toBe(false)

  await page.evaluate(() => {
    document.addEventListener(
      'keydown',
      (event) => {
        if (event.key === 'q') document.body.dataset.forwardedKey = event.key
      },
      { capture: true, once: true }
    )
  })
  await body.locator('#styled-table').click()
  expect(
    await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'html-body-frame')
  ).toBe(true)
  await page.keyboard.press('q')
  await expect(page.locator('body')).toHaveAttribute('data-forwarded-key', 'q')
  await page.keyboard.press('k')
  await expect(page.getByTestId('conversation-position')).toHaveText('7 of 8')
  await page.keyboard.press('j')
  await expect(page.getByTestId('conversation-subject')).toHaveText('This week in focus')
  await page.getByTestId('mail-trim-toggle').click()
  await expect
    .poll(() =>
      iframe.evaluate((element) => {
        const frame = element as HTMLIFrameElement
        const scrollHeight = frame.contentDocument?.documentElement.scrollHeight ?? 0
        return frame.clientHeight > 2500 && scrollHeight <= frame.clientHeight + 1
      })
    )
    .toBe(true)
  await body.locator('#styled-table').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('conversation-pane')).toHaveCount(0)

  const dir = join(__dirname, '.artifacts')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'reading.png')
  await page.getByTestId('thread-row').filter({ hasText: 'This week in focus' }).dblclick()
  await page.screenshot({ path })
  await testInfo.attach('reading', { path, contentType: 'image/png' })

  await page.keyboard.press('Escape')
  await page.getByTestId('thread-row').filter({ hasText: 'Your receipt' }).dblclick()
  await expect(page.getByTestId('html-body-frame')).toBeVisible()
  await expect(
    page.frameLocator('[data-testid="html-body-frame"]').locator('#plain-html-copy')
  ).toContainText('Your order total was $24.00.')
  const simpleMailPath = join(dir, 'simple-mail.png')
  await page.screenshot({ path: simpleMailPath })
  await testInfo.attach('simple mail', { path: simpleMailPath, contentType: 'image/png' })

  await page.keyboard.press('Escape')
  await page.getByTestId('thread-row').filter({ hasText: 'Q3 roadmap review' }).dblclick()
  await expect(page.getByTestId('html-body-frame')).toHaveCount(0)
  await expect(page.getByTestId('plain-text-body')).toHaveCount(2)
  await expect(page.getByTestId('plain-text-body').last().getByTestId('plain-text-visible')).toHaveText(
    'I added the launch milestones and owner notes.'
  )

  await page.keyboard.press('Escape')
  await page.getByTestId('thread-row').filter({ hasText: 'This week in focus' }).dblclick()
  await page.evaluate(() => {
    document.addEventListener(
      'keydown',
      (event) => {
        document.body.dataset.shiftedKey = `${event.key}:${event.shiftKey}`
      },
      { capture: true }
    )
  })
  await body.locator('#styled-table').click()
  await page.keyboard.press('Shift+#')
  await expect(page.locator('body')).toHaveAttribute('data-shifted-key', '#:true')
  await expect(page.getByTestId('thread-row')).toHaveCount(7)
  await expect(page.getByTestId('thread-row').filter({ hasText: 'This week in focus' })).toHaveCount(0)
  await expect(page.getByTestId('conversation-subject')).toHaveText('Research summary')
})
