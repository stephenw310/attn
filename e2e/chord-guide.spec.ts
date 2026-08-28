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
  await expect.poll(() => footerHintIds(page)).toEqual(['navigate', 'open', 'done', 'snooze', 'move', 'undo'])

  await page.keyboard.press('Enter')
  await expect(page.getByTestId('conversation-view')).toBeVisible()
  await expect
    .poll(() => footerHintIds(page))
    .toEqual(['reply', 'done', 'snooze', 'move', 'navigate', 'back'])

  await page.keyboard.press('Escape')
  await page.keyboard.press('g')
  await page.keyboard.press('o')
  await expect(page.getByTestId('view-title')).toHaveText('Outbox')
  await expect.poll(() => footerHintIds(page)).toEqual(['navigate', 'open', 'back', 'undo'])
})

test('guides G completions and clears on every dismissal route', async ({ page }, testInfo) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(1)
  const guide = page.getByTestId('footer-chord-guide')

  await page.keyboard.press('g')
  await expect(guide).toHaveAttribute('data-prefix', 'g')
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
      ['o', 'OOutbox'],
      ['1', '1Calendar'],
      ['2', '2GitHub'],
      ['3', '3Newsletters'],
      ['4', '4Important'],
      ['5', '5Other']
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
  await page.waitForTimeout(700)
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
  await page.waitForTimeout(2_100)
  await expect(guide).toHaveCount(0)
  await page.keyboard.press('a')
  await expect(page.getByTestId('view-title')).toHaveText('Inbox')
})
