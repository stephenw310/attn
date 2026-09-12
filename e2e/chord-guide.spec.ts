import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-splits.json' })

async function footerHintIds(page: import('@playwright/test').Page): Promise<(string | undefined)[]> {
  return page
    .getByTestId('footer-shortcuts')
    .evaluate((element) =>
      Array.from(element.querySelectorAll('[data-testid^="footer-shortcut-"]')).map((hint) =>
        hint.getAttribute('data-testid')?.replace('footer-shortcut-', '')
      )
    )
}

test('shows the minimal registry-derived footer for each keyboard context', async ({ page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(1)
  await expect
    .poll(() => footerHintIds(page))
    .toEqual(['navigate', 'open', 'done', 'compose', 'undo', 'palette', 'go-to'])
  await expect(page.getByTestId('footer-shortcut-compose')).toBeInViewport()
  await expect(page.getByTestId('footer-shortcut-palette')).toContainText('Command palette')

  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await expect
    .poll(() => footerHintIds(page))
    .toEqual(['message-navigation', 'message-toggle', 'reply', 'done', 'snooze', 'back'])
  await expect(page.getByTestId('footer-shortcut-message-navigation')).toBeInViewport()
  await expect(page.getByTestId('footer-shortcut-message-toggle')).toBeInViewport()

  await page.keyboard.press('Escape')
  await page.keyboard.press('g')
  await page.keyboard.press('d')
  await expect(page.getByTestId('view-title')).toHaveText('Drafts')
  await expect
    .poll(() => footerHintIds(page))
    .toEqual(['navigate', 'open', 'delete-draft', 'compose', 'undo', 'palette', 'go-to'])
  await expect(page.getByTestId('footer-shortcut-delete-draft')).toBeInViewport()

  await page.keyboard.press('g')
  await page.keyboard.press('o')
  await expect(page.getByTestId('view-title')).toHaveText('Outbox')
  await expect.poll(() => footerHintIds(page)).toEqual(['navigate', 'open', 'back', 'undo'])
})

test('Escape leaves the reader while the G guide is armed', async ({ page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(1)
  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-view')).toBeVisible()

  await page.keyboard.press('g')
  await expect(page.getByTestId('footer-chord-guide')).toBeVisible()
  await page.keyboard.press('Escape')

  await expect(page.getByTestId('footer-chord-guide')).toHaveCount(0)
  await expect(page.getByTestId('conversation-view')).toHaveCount(0)
  await expect(page.getByTestId('thread-list')).toBeVisible()
})

test('guides G completions and clears on every dismissal route', async ({ page }, testInfo) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(1)
  await page.clock.install()
  const guide = page.getByTestId('footer-chord-guide')

  await page.keyboard.press('g')
  await expect(guide).toHaveAttribute('data-prefix', 'g')
  await expect(guide).not.toContainText('→')
  await expect(page.getByTestId('footer-shortcut-navigate')).toHaveCount(0)
  await expect
    .poll(() =>
      page.getByTestId('footer-shortcuts').evaluate((element) => element.scrollWidth <= element.clientWidth)
    )
    .toBe(true)
  await expect
    .poll(() =>
      guide
        .locator('[data-testid^="footer-chord-"]')
        .evaluateAll((items) =>
          items.map((item) => [
            item.getAttribute('data-testid')?.replace('footer-chord-', ''),
            item.textContent
          ])
        )
    )
    .toEqual([
      ['i', 'IInbox'],
      ['a', 'AAll Mail'],
      ['t', 'TSent'],
      ['d', 'DDrafts'],
      ['s', 'SStarred'],
      ['h', 'HSnoozed'],
      ['p', 'PSpam'],
      ['r', 'RTrash'],
      ['o', 'OOutbox']
    ])

  const artifactDirectory = join(__dirname, '.artifacts')
  mkdirSync(artifactDirectory, { recursive: true })
  const path = join(artifactDirectory, 'chord-guide.png')
  await page.screenshot({ path })
  await testInfo.attach('chord-guide', { path, contentType: 'image/png' })

  await page.keyboard.press('Escape')
  await expect(guide).toHaveCount(0)
  await expect(page.getByTestId('view-title')).toHaveText('Inbox')

  await page.keyboard.press('g')
  await expect(guide).toBeVisible()
  await page.getByTestId('sidebar-mailbox').filter({ hasText: 'Starred' }).click()
  await expect(page.getByTestId('view-title')).toHaveText('Starred')
  await expect(guide).toHaveCount(0)

  await page.keyboard.press('g')
  await page.clock.fastForward(700)
  await page.keyboard.press('r')
  await expect(page.getByTestId('view-title')).toHaveText('Trash')
  await expect(page.getByTestId('composer')).toHaveCount(0)

  await page.keyboard.press('g')
  await page.keyboard.press('i')
  await expect(page.getByTestId('view-title')).toHaveText('Inbox')

  await page.keyboard.press('g')
  await page.keyboard.press('g')
  await expect(guide).toBeVisible()
  await page.keyboard.press('a')
  await expect(page.getByTestId('view-title')).toHaveText('All Mail')

  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', repeat: true, bubbles: true }))
  })
  await expect(guide).toHaveCount(0)
  await page.keyboard.press('g')
  await page.keyboard.press('i')
  await expect(page.getByTestId('view-title')).toHaveText('Inbox')

  await page.keyboard.press('g')
  await expect(guide).toBeVisible()
  await page.clock.fastForward(3_100)
  await expect(guide).toHaveCount(0)
  await page.keyboard.press('a')
  await expect(page.getByTestId('view-title')).toHaveText('Inbox')
})

test('cancels pending chords before overlays stop keyboard propagation', async ({ page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(1)
  const guide = page.getByTestId('footer-chord-guide')

  await page.keyboard.press('g')
  await expect(guide).toBeVisible()
  await page.getByTestId('account-menu').getByRole('button').first().click()
  await expect(page.getByTestId('theme-picker')).toBeVisible()
  await expect(guide).toHaveCount(0)

  await page.keyboard.press('g')
  await expect(guide).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('theme-picker')).toHaveCount(0)
  await expect(guide).toHaveCount(0)
  await page.keyboard.press('o')
  await expect(page.getByTestId('view-title')).toHaveText('Inbox')

  await page.keyboard.press('g')
  await expect(guide).toBeVisible()
  // MessageBody and quoted-history iframes forward the palette shortcut from
  // their frame element, so no standalone modifier keydown reaches the parent.
  await page.evaluate(() => {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'k',
        code: 'KeyK',
        ctrlKey: true,
        bubbles: true,
        cancelable: true
      })
    )
  })
  await expect(page.getByTestId('command-palette')).toBeVisible()
  await expect(guide).toHaveCount(0)
  await page.keyboard.press('Escape')
  await expect(page.getByTestId('command-palette')).toHaveCount(0)
  await page.keyboard.press('o')
  await expect(page.getByTestId('view-title')).toHaveText('Inbox')
})

test('keeps footer hints visible when switching between compact list and reader contexts', async ({
  app,
  page
}) => {
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setContentSize(900, 420)
  })
  await expect(page.getByTestId('thread-row')).toHaveCount(1)
  const footer = page.getByTestId('mail-footer')
  const shortcuts = page.getByTestId('footer-shortcuts')
  const initialHeight = await footer.evaluate((element) => element.getBoundingClientRect().height)

  await expect
    .poll(() =>
      shortcuts.evaluate((element) => ({
        overflows: element.scrollWidth > element.clientWidth,
        scrollbarHeight: Math.round(element.getBoundingClientRect().height - element.clientHeight)
      }))
    )
    .toEqual({ overflows: false, scrollbarHeight: 0 })

  await expect(page.getByTestId('footer-shortcut-palette')).toBeInViewport()
  await expect(page.getByTestId('footer-shortcut-go-to')).toBeInViewport()
  await page.keyboard.press('g')
  await expect(page.getByTestId('footer-chord-guide')).toBeVisible()
  await expect
    .poll(() => footer.evaluate((element) => element.getBoundingClientRect().height))
    .toBeLessThanOrEqual(initialHeight)
  await expect
    .poll(() =>
      shortcuts.evaluate((element) => ({
        overflows: element.scrollWidth > element.clientWidth,
        scrollbarHeight: Math.round(element.getBoundingClientRect().height - element.clientHeight)
      }))
    )
    .toEqual({ overflows: false, scrollbarHeight: 0 })
  await page.keyboard.press('Escape')
  await expect.poll(() => shortcuts.evaluate((element) => element.scrollLeft)).toBe(0)

  await page.getByTestId('thread-row').first().click()
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await expect.poll(() => shortcuts.evaluate((element) => element.scrollLeft)).toBe(0)
  await expect
    .poll(() => footer.evaluate((element) => element.getBoundingClientRect().height))
    .toBeLessThanOrEqual(initialHeight)
  await expect
    .poll(() =>
      shortcuts.evaluate((element) => ({
        overflows: element.scrollWidth > element.clientWidth,
        scrollbarHeight: Math.round(element.getBoundingClientRect().height - element.clientHeight)
      }))
    )
    .toEqual({ overflows: false, scrollbarHeight: 0 })

  await page.keyboard.press('Escape')
  await expect(page.getByTestId('conversation-view')).toHaveCount(0)
  await expect.poll(() => shortcuts.evaluate((element) => element.scrollLeft)).toBe(0)
})
