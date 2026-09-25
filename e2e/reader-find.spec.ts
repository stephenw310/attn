import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC_CHANNELS } from '../src/shared/ipc'
import { expect, test } from './electron'
import { runPaletteCommand, threadRow } from './nav'
import { observeInvokes } from './seams'

test.use({ seed: 'fixtures/seed-inbox.json' })

test('finds collapsed bodies and quoted text, wraps, and closes before the reader', async ({ page }) => {
  await threadRow(page, 'Q3 roadmap review').click()
  await page.keyboard.press('ControlOrMeta+f')
  const input = page.getByTestId('reader-find-input')
  const count = page.getByTestId('reader-find-count')
  await expect(input).toBeFocused()
  await input.fill('ROADMAP')
  await expect(count).toHaveText('1 of 1')
  await expect(page.getByTestId('message-card').first()).toHaveAttribute('data-collapsed', 'false')
  await input.fill('milestone')
  await expect(count).toHaveText('1 of 2')
  await input.press('Enter')
  await expect(count).toHaveText('2 of 2')
  await expect(page.getByTestId('plain-text-trimmed')).toBeVisible()
  await input.press('Enter')
  await expect(count).toHaveText('1 of 2')
  await input.press('Shift+Enter')
  await expect(count).toHaveText('2 of 2')
  await page.getByRole('button', { name: 'Previous match', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(count).toHaveText('1 of 2')
  await expect(page.getByTestId('compose-editor')).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+f')
  await expect(input).toBeFocused()
  expect(
    await input.evaluate(
      (element: HTMLInputElement) => (element.selectionEnd ?? 0) - (element.selectionStart ?? 0)
    )
  ).toBe(9)
  await input.fill('no-such-phrase')
  await expect(count).toHaveText('No matches')
  await expect(page.getByRole('button', { name: 'Next match', exact: true })).toBeDisabled()
  await input.press('Escape')
  await expect(input).toHaveCount(0)
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  expect(await page.evaluate(() => CSS.highlights.has('attn-find'))).toBe(false)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('conversation-view')).toHaveCount(0)
  await threadRow(page, 'Q3 roadmap review').click()
  await runPaletteCommand(page, 'Find in conversation')
  await expect(input).toHaveValue('')
})

for (const appearance of ['light', 'dark'] as const) {
  test(`finds HTML from frame focus in the ${appearance} reader`, async ({ page }, testInfo) => {
    await runPaletteCommand(page, `Use ${appearance === 'dark' ? 'Dark' : 'Light'} theme`)
    await threadRow(page, 'This week in focus').click()
    const frame = page.getByTestId('html-body-frame')
    const body = page.frameLocator('[data-testid="html-body-frame"]')
    await expect(body.locator('#styled-table')).toBeVisible()
    await body.locator('#self-link').focus()
    await page.keyboard.press('ControlOrMeta+f')
    const input = page.getByTestId('reader-find-input')
    await expect(input).toBeFocused()
    await input.fill('copy')
    await expect(page.getByTestId('reader-find-count')).toHaveText('1 of 2')
    expect(
      await frame.evaluate((element: HTMLIFrameElement) => {
        const view = element.contentWindow as Window & typeof globalThis
        return view.CSS.highlights.get('attn-find')?.size
      })
    ).toBe(2)
    await input.press('Enter')
    await expect(page.getByTestId('reader-find-count')).toHaveText('2 of 2')
    const path = join(__dirname, '.artifacts', `reader-find-${appearance}.png`)
    mkdirSync(join(__dirname, '.artifacts'), { recursive: true })
    await page.screenshot({ path })
    await testInfo.attach(`reader-find-${appearance}`, { path, contentType: 'image/png' })
    await expect(frame).toHaveAttribute(
      'sandbox',
      'allow-same-origin allow-popups allow-popups-to-escape-sandbox'
    )
    await expect(body.locator('script')).toHaveCount(0)
    await input.fill('Earlier weekly digest')
    await expect(page.getByTestId('reader-find-count')).toHaveText('1 of 1')
    await expect(page.getByTestId('mail-trim-toggle')).toHaveAttribute('aria-expanded', 'true')
    await body.locator('#self-link').focus()
    await page.keyboard.press('Escape')
    await expect(input).toHaveCount(0)
    await expect(page.getByTestId('conversation-view')).toBeVisible()
    expect(
      await frame.evaluate((element: HTMLIFrameElement) => {
        const view = element.contentWindow as Window & typeof globalThis
        return view.CSS.highlights.has('attn-find')
      })
    ).toBe(false)
  })
}

test.describe('find across authored and quoted HTML', () => {
  test.use({ seed: 'fixtures/seed-mail-layout.json' })

  for (const appearance of ['light', 'dark'] as const) {
    test(`reveals only the selected history in ${appearance}`, async ({ page }, testInfo) => {
      await runPaletteCommand(page, `Use ${appearance === 'dark' ? 'Dark' : 'Light'} theme`)
      await threadRow(page, 'Simple reply with rich history').click()
      await expect(page.getByTestId('html-body-frame')).toHaveCount(2)
      await page.keyboard.press('ControlOrMeta+f')
      const input = page.getByTestId('reader-find-input')
      const count = page.getByTestId('reader-find-count')
      await input.fill('build')
      await expect(count).toHaveText('1 of 3')
      await expect(page.getByTestId('mail-quoted-section')).toBeHidden()
      await input.press('Enter')
      await expect(count).toHaveText('2 of 3')
      await expect(page.getByTestId('mail-quoted-section')).toBeVisible()
      await input.press('Enter')
      await expect(count).toHaveText('3 of 3')
      await expect
        .poll(() =>
          page.getByTestId('conversation-scroll').evaluate((scroll) => {
            const bounds = scroll.getBoundingClientRect()
            for (const frame of scroll.querySelectorAll('iframe')) {
              const view = frame.contentWindow as Window & typeof globalThis
              const range = [...(view.CSS.highlights.get('attn-find-active') ?? [])][0] as Range | undefined
              if (!range) continue
              const rect = range.getBoundingClientRect()
              const top = frame.getBoundingClientRect().top + rect.top
              return top >= bounds.top && top + rect.height <= bounds.bottom
            }
            return false
          })
        )
        .toBe(true)
      const path = join(__dirname, '.artifacts', `reader-find-mixed-${appearance}.png`)
      mkdirSync(join(__dirname, '.artifacts'), { recursive: true })
      await page.screenshot({ path })
      await testInfo.attach(`reader-find-mixed-${appearance}`, { path, contentType: 'image/png' })
      for (const frame of await page.getByTestId('html-body-frame').all()) {
        await expect(frame).toHaveAttribute('data-load-count', '1')
      }
    })
  }
})

test.describe('collapsed message resources', () => {
  const seed = '.generated/reader-find-images.json'
  test.use({ seed })
  test.beforeEach(() => {
    const message = (id: string, receivedDaysAgo: number) => ({
      id,
      receivedDaysAgo,
      receivedAt: '09:00',
      labelIds: ['INBOX'],
      from: 'Sender <sender@example.test>',
      to: 'seed@attn.test',
      subject: 'Find without loading images'
    })
    mkdirSync(join(__dirname, '.generated'), { recursive: true })
    writeFileSync(
      join(__dirname, seed),
      JSON.stringify({
        account: 'seed@attn.test',
        threads: [
          {
            id: 't-find-images',
            messages: [
              ...['older', 'middle'].map((id, index) => ({
                ...message(id, 2 - index),
                bodyHtml: `<p>${id} <b>needle</b> phrase</p><img src="cid:${id}@attn.test"><img src="https://find-images.attn.test/${id}.gif"><style>p { background-image: url(https://find-images.attn.test/${id}-background.gif) }</style>`,
                attachments: [
                  {
                    attachmentId: `inline:${id}`,
                    mimeType: 'image/gif',
                    sizeBytes: 35,
                    contentId: `${id}@attn.test`,
                    dataBase64Url: 'R0lGODlhAQABAAD_ACwAAAAAAQABAAACADs'
                  }
                ]
              })),
              { ...message('newest', 0), bodyText: 'Current message' }
            ]
          }
        ]
      })
    )
  })

  test('find loads images only after their collapsed message is expanded', async ({ app, page }) => {
    const requests: string[] = []
    await page.route('https://find-images.attn.test/**', async (route) => {
      requests.push(route.request().url())
      await route.fulfill({
        contentType: 'image/gif',
        body: Buffer.from('R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=', 'base64')
      })
    })
    const inlineCalls = await observeInvokes(app, IPC_CHANNELS.mailGetInlineImage)
    await threadRow(page, 'Find without loading images').click()
    await page.keyboard.press('ControlOrMeta+f')
    const input = page.getByTestId('reader-find-input')
    await expect(input).toBeFocused()
    await expect(page.locator('[data-find-body][hidden]')).toHaveCount(2)
    await input.fill('absent')
    await expect(page.getByTestId('reader-find-count')).toHaveText('No matches')
    // Give any mistakenly mounted frames time to issue their image requests.
    await page.waitForTimeout(200)
    expect(await inlineCalls()).toEqual([])
    expect(requests).toEqual([])
    await expect(page.getByTestId('html-body-frame')).toHaveCount(0)

    await input.fill('needle phrase')
    await expect(page.getByTestId('reader-find-count')).toHaveText('1 of 2')
    await expect(page.getByTestId('html-body-frame')).toHaveCount(1)
    await expect
      .poll(async () => (await inlineCalls()).map((args) => (args[0] as { messageId: string }).messageId))
      .toEqual(['older'])
    await expect.poll(() => requests.length).toBe(2)
    expect(requests.every((url) => url.includes('/older'))).toBe(true)
    await expect(page.frameLocator('[data-testid="html-body-frame"]').locator('img').first()).toHaveAttribute(
      'src',
      /^data:image\/gif;base64,/
    )

    await input.press('Enter')
    await expect(page.getByTestId('reader-find-count')).toHaveText('2 of 2')
    await expect(page.getByTestId('html-body-frame')).toHaveCount(2)
    await expect
      .poll(async () => (await inlineCalls()).map((args) => (args[0] as { messageId: string }).messageId))
      .toEqual(['older', 'middle'])
    await expect.poll(() => requests.length).toBe(4)
    await expect
      .poll(() =>
        page
          .getByTestId('html-body-frame')
          .nth(1)
          .evaluate((frame: HTMLIFrameElement) => {
            const view = frame.contentWindow as Window & typeof globalThis
            return [...(view.CSS.highlights.get('attn-find-active') ?? [])].map((range) => range.toString())
          })
      )
      .toEqual(['needle phrase'])
  })
})
