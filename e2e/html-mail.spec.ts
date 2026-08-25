import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-inbox.json' })

test('sanitizes hostile HTML in a scriptless iframe and preserves plain text mail', async ({
  page
}, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark' })
  let remoteImageRequests = 0
  let handlerImageRequests = 0
  let releaseRemoteImage!: () => void
  const remoteImageGate = new Promise<void>((resolve) => {
    releaseRemoteImage = resolve
  })
  await page.route('https://remote.attn.test/**', async (route) => {
    remoteImageRequests += 1
    await remoteImageGate
    await route.fulfill({
      contentType: 'image/gif',
      body: Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64')
    })
  })
  await page.route('https://handler.attn.test/**', async (route) => {
    handlerImageRequests += 1
    await route.fulfill({ contentType: 'image/gif', body: 'not an image' })
  })

  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  const weeklyThread = page.getByTestId('thread-row').filter({ hasText: 'This week in focus' })
  await expect(weeklyThread.locator('[title="Has attachment"]')).toHaveCount(0)
  await weeklyThread.click()

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
  await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-layout', 'padded')
  await expect(body.locator('body')).toHaveCSS('padding-left', '0px')
  await expect(body.locator('body')).toHaveCSS('padding-right', '0px')
  await expect(body.locator('#styled-table')).toHaveAttribute('style', /border-collapse/)
  await expect(body.locator('#mail-styles')).toHaveCount(1)
  await expect(body.locator('#stylesheet-styled')).toHaveCSS('color', 'rgb(12, 34, 56)')
  await expect(body.locator('#dark-mode-copy')).toHaveCSS('color', 'rgb(17, 34, 51)')
  await expect(body.locator('#invite-details')).toContainText('Invite: roadmap review at 10:00')
  await expect(body.locator('#custom-card-copy')).toHaveText('Important custom-card content')
  await expect(body.locator('script')).toHaveCount(0)
  await expect(body.locator('[onerror]')).toHaveCount(0)
  await expect(body.locator('a[href^="javascript:"]')).toHaveCount(0)
  await expect(body.locator('#schemeless-link')).toHaveAttribute(
    'href',
    'https://www.kimi.com?referer=upcoming_invoice'
  )
  await expect(body.locator('#remote-image')).toHaveAttribute('data-attn-image-pending', '')
  await expect(body.locator('#remote-image')).toHaveCSS('visibility', 'hidden')
  releaseRemoteImage()
  await expect(body.locator('#remote-image')).not.toHaveAttribute('data-attn-image-pending')
  await expect(body.locator('#remote-image')).toHaveCSS('visibility', 'visible')
  await expect(body.locator('#cid-image')).toHaveAttribute('src', /^data:image\/gif;base64,/)
  await expect(body.locator('#filename-cid-image')).toHaveAttribute('src', /^data:image\/png;base64,/)
  await expect(iframe).toHaveAttribute('data-load-count', '1')
  await expect(body.locator('#malformed-cid-image')).not.toHaveAttribute('src')
  await expect(body.locator('#malformed-cid-image')).toHaveCSS('visibility', 'hidden')
  await expect(body.locator('#cid-image')).toBeVisible()
  await expect(body.locator('#filename-cid-image')).toBeVisible()
  await expect(page.getByTestId('attachment-chip')).toHaveCount(0)
  await expect
    .poll(() =>
      page.evaluate(() => {
        const footer = document.querySelector<HTMLElement>('[data-testid="mail-footer"]')
        return (
          document.scrollingElement?.scrollTop === 0 &&
          footer !== null &&
          Math.abs(footer.getBoundingClientRect().bottom - window.innerHeight) < 1
        )
      })
    )
    .toBe(true)
  // The sender ships its own copies of our marker attributes. Both must be stripped:
  // a surviving trim marker would move the fold to wherever the sender wants, and a
  // surviving cid marker would aim the inline-image patch at the sender's element.
  await expect(body.locator('#forged-trim-anchor')).toHaveCount(1)
  await expect(body.locator('#forged-trim-anchor')).not.toHaveAttribute('data-attn-trim-start')
  await expect(body.locator('#forged-cid')).not.toHaveAttribute('data-attn-cid-source')
  await expect(body.locator('#forged-cid')).not.toHaveAttribute('src')
  await expect(body.locator('#forged-cid')).toHaveCSS('visibility', 'hidden')
  await expect(body.locator('#handler-image')).toHaveCSS('visibility', 'hidden')
  await expect(body.locator('[data-attn-trim-start]')).toHaveCount(1)
  await expect(body.locator('form, input, button, select, textarea')).toHaveCount(0)
  await expect(body.locator('#self-link')).toHaveAttribute('target', '_blank')
  await expect(body.locator('#top-link')).toHaveAttribute('target', '_blank')
  expect(
    await iframe.evaluate((element) => {
      const event = new KeyboardEvent('keydown', {
        key: 'Enter',
        code: 'Enter',
        bubbles: true,
        cancelable: true
      })
      element.dispatchEvent(event)
      return event.defaultPrevented
    })
  ).toBe(true)
  await expect(page.getByTestId('composer')).toHaveAttribute('data-draft-kind', 'replyAll')
  await page.getByTestId('composer-discard').click()
  await expect(page.getByTestId('composer')).toHaveCount(0)
  await expect(page.getByTestId('toast')).toHaveCount(0, { timeout: 5_000 })
  await expect(body.locator('#remote-image')).toHaveAttribute('src', 'https://remote.attn.test/tracker.gif')
  await expect.poll(() => remoteImageRequests).toBe(1)
  await expect.poll(() => handlerImageRequests).toBe(1)

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
      void window.attn.mail.triage({ kind: 'star', threadIds: ['t-weekly'], on: true })
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
  await page
    .getByTestId('conversation-content')
    .evaluate((element) => element.style.setProperty('min-height', '4000px'))
  await page
    .getByTestId('conversation-scroll')
    .evaluate((element) => element.scrollTo({ top: 600, behavior: 'instant' }))
  await expect
    .poll(() => page.getByTestId('conversation-scroll').evaluate((element) => element.scrollTop))
    .toBe(600)
  await page.keyboard.press('k')
  await expect(page.getByTestId('conversation-position')).toHaveText('7 of 8')
  await expect
    .poll(() => page.getByTestId('conversation-scroll').evaluate((element) => element.scrollTop))
    .toBe(0)
  await page
    .getByTestId('conversation-content')
    .evaluate((element) => element.style.removeProperty('min-height'))
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
  await expect(page.getByTestId('conversation-view')).toHaveCount(0)

  const dir = join(__dirname, '.artifacts')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'reading.png')
  await page.getByTestId('thread-row').filter({ hasText: 'This week in focus' }).click()
  await page.screenshot({ path })
  await testInfo.attach('reading', { path, contentType: 'image/png' })

  await page.keyboard.press('Escape')
  await page.getByTestId('thread-row').filter({ hasText: 'Your receipt' }).click()
  await expect(page.getByTestId('html-body-frame')).toBeVisible()
  await expect(page.getByTestId('html-body-container')).toHaveAttribute('data-surface', 'native')
  await expect(page.getByTestId('message-content')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
  await expect(
    page.frameLocator('[data-testid="html-body-frame"]').locator('#plain-html-copy')
  ).toContainText('Your order total was $24.00.')
  await expect(page.frameLocator('[data-testid="html-body-frame"]').locator('body')).toHaveCSS(
    'background-color',
    'rgba(0, 0, 0, 0)'
  )
  await page.evaluate(() => window.getSelection()?.removeAllRanges())
  await page
    .frameLocator('[data-testid="html-body-frame"]')
    .locator('body')
    .evaluate((body) => body.ownerDocument.getSelection()?.removeAllRanges())
  const simpleMailPath = join(dir, 'simple-mail.png')
  await page.screenshot({ path: simpleMailPath })
  await testInfo.attach('simple mail', { path: simpleMailPath, contentType: 'image/png' })

  await page.keyboard.press('Escape')
  await page.getByTestId('thread-row').filter({ hasText: 'Q3 roadmap review' }).click()
  await expect(page.getByTestId('html-body-frame')).toHaveCount(0)
  await expect(page.getByTestId('plain-text-body')).toHaveCount(1)
  await expect(page.getByTestId('message-card').first()).toHaveAttribute('data-collapsed', 'true')
  await expect(page.getByTestId('message-card').last()).toHaveCSS('padding-left', '20px')
  await expect(page.getByTestId('message-card').last()).toHaveCSS('padding-right', '20px')
  await expect(page.getByTestId('plain-text-body').last().getByTestId('plain-text-visible')).toHaveText(
    'I added the launch milestones and owner notes.'
  )

  await page.keyboard.press('Escape')
  await page.getByTestId('thread-row').filter({ hasText: 'This week in focus' }).click()
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

test('loads direct mail images when the sender restricts cross-origin embedding', async ({ page }) => {
  const pixel = Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64')
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      'Content-Type': 'image/gif',
      'Content-Length': pixel.length,
      'Cross-Origin-Resource-Policy': 'same-origin'
    })
    response.end(pixel)
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })

  try {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('Image test server did not start')
    await page.getByTestId('thread-row').filter({ hasText: 'Your receipt' }).click()
    await expect(page.getByTestId('html-body-frame')).toBeVisible()
    const body = page.frameLocator('[data-testid="html-body-frame"]')
    await body.locator('body').evaluate((mailBody, imageUrl) => {
      const image = document.createElement('img')
      image.id = 'corp-image'
      image.src = imageUrl
      mailBody.append(image)
    }, `http://127.0.0.1:${address.port}/sender-image.gif`)
    await expect
      .poll(() => body.locator('#corp-image').evaluate((image) => (image as HTMLImageElement).naturalWidth))
      .toBe(1)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
})
