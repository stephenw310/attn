import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './electron'
import { runPaletteCommand } from './nav'

const seed = '.generated/search-years.json'
test.use({ seed })
test.beforeAll(() => {
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  mkdirSync(join(__dirname, '.generated'), { recursive: true })
  writeFileSync(
    join(__dirname, seed),
    JSON.stringify({
      account: 'seed@attn.test',
      threads: [0, 1, 2].map((offset) => ({
        id: 'year-' + offset,
        messages: [
          {
            id: 'message-' + offset,
            labelIds: ['INBOX'],
            receivedDaysAgo: Math.round(
              (today.getTime() - new Date(now.getFullYear() - offset, 0, 1).getTime()) / 86400000
            ),
            receivedAt: '09:00',
            from: 'Planning <planning@example.test>',
            to: 'seed@attn.test',
            subject: 'Annual review ' + (now.getFullYear() - offset),
            bodyText: 'Annual review notes for the team.'
          }
        ]
      }))
    })
  )
})
for (const theme of ['Light', 'Dark']) {
  test('search timestamps distinguish calendar years ' + theme, async ({ page }) => {
    await runPaletteCommand(page, 'Use ' + theme + ' theme')
    await runPaletteCommand(page, 'Use Matcha color palette')
    await page.keyboard.press('/')
    await page.getByTestId('search-input').fill('Annual review')
    await expect(page.getByTestId('thread-row')).toHaveCount(3)
    const year = new Date().getFullYear()
    for (const offset of [1, 2]) {
      await expect(
        page.locator('[data-thread-id="year-' + offset + '"]').getByTestId('thread-time')
      ).toContainText(String(year - offset))
    }
    await expect(page.locator('[data-thread-id="year-0"]').getByTestId('thread-time')).not.toContainText(
      String(year)
    )
    await expect(page.getByTestId('thread-date-group')).toHaveCount(0)
    await page.mouse.move(0, 0)
    await page.screenshot({
      path: join(__dirname, '.artifacts', 'search-years-' + theme.toLowerCase() + '.png')
    })
  })
}
