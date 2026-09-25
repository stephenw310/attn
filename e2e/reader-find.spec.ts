import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './electron'
import { runPaletteCommand, threadRow } from './nav'

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
