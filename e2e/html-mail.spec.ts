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
  await expect(iframe).toHaveAttribute(
    'sandbox',
    'allow-same-origin allow-popups allow-popups-to-escape-sandbox'
  )

  const body = page.frameLocator('[data-testid="html-body-frame"]')
  await expect(body.locator('#styled-table')).toBeVisible()
  await expect(body.locator('#styled-table')).toHaveAttribute('style', /border-collapse/)
  await expect(body.locator('script')).toHaveCount(0)
  await expect(body.locator('[onerror]')).toHaveCount(0)
  await expect(body.locator('a[href^="javascript:"]')).toHaveCount(0)
  await expect(body.locator('form, input, button, select, textarea')).toHaveCount(0)
  await expect(body.locator('#remote-image')).toHaveAttribute('src', 'https://remote.attn.test/tracker.gif')
  await expect.poll(() => remoteImageRequested).toBe(true)
  await expect.poll(() => handlerImageRequested).toBe(true)

  for (const marker of ['data-script-ran', 'data-handler-ran', 'data-link-ran']) {
    expect(await body.locator('body').getAttribute(marker)).toBeNull()
    expect(await page.locator('body').getAttribute(marker)).toBeNull()
  }

  await expect
    .poll(() =>
      iframe.evaluate((element) => {
        const frame = element as HTMLIFrameElement
        const scrollHeight = frame.contentDocument?.documentElement.scrollHeight ?? 0
        return frame.clientHeight > 80 && scrollHeight > frame.clientHeight
      })
    )
    .toBe(true)
  const stableHeight = await iframe.evaluate((element) => element.clientHeight)
  expect(stableHeight).toBeLessThan(2000)
  await page.waitForTimeout(250)
  expect(await iframe.evaluate((element) => element.clientHeight)).toBe(stableHeight)

  await body.locator('#styled-table').click()
  expect(
    await page.evaluate(() => document.activeElement?.getAttribute('data-testid') === 'html-body-frame')
  ).toBe(true)
  await page.keyboard.press('k')
  await expect(page.getByTestId('conversation-position')).toHaveText('7 of 8')
  await page.keyboard.press('j')
  await expect(page.getByTestId('conversation-subject')).toHaveText('This week in focus')
  await expect
    .poll(() =>
      iframe.evaluate((element) => {
        const frame = element as HTMLIFrameElement
        const scrollHeight = frame.contentDocument?.documentElement.scrollHeight ?? 0
        return frame.clientHeight > 80 && scrollHeight > frame.clientHeight
      })
    )
    .toBe(true)
  await body.locator('#styled-table').click()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('conversation-overlay')).toHaveCount(0)

  const dir = join(__dirname, '.artifacts')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, 'conversation.png')
  await page.getByTestId('thread-row').filter({ hasText: 'This week in focus' }).dblclick()
  await page.screenshot({ path })
  await testInfo.attach('conversation', { path, contentType: 'image/png' })

  await page.keyboard.press('Escape')
  await page.getByTestId('thread-row').filter({ hasText: 'Your receipt' }).dblclick()
  await expect(page.getByTestId('html-body-frame')).toHaveCount(0)
  await expect(page.getByTestId('plain-text-body')).toHaveText('Your order total was $24.00.')

  await page.keyboard.press('Escape')
  await page.getByTestId('thread-row').filter({ hasText: 'Q3 roadmap review' }).dblclick()
  await expect(page.getByTestId('html-body-frame')).toHaveCount(0)
  await expect(page.getByTestId('plain-text-body')).toHaveCount(2)
  await expect(page.getByTestId('plain-text-body').last()).toHaveText(
    'I added the launch milestones and owner notes.'
  )
})
