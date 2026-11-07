import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './electron'
import { goTo } from './nav'
import { flushRendererIpc } from './seams'

const seed = '.generated/unread-mailboxes.json'
test.use({ seed })
test.beforeEach(() => {
  mkdirSync(join(__dirname, '.generated'), { recursive: true })
  writeFileSync(
    join(__dirname, seed),
    JSON.stringify({
      account: 'unread@attn.test',
      labels: [{ id: 'Label_Filter', name: 'Filter label', type: 'user' }],
      threads: ['normal', 'spam', 'trash', 'snoozed'].flatMap((group) =>
        [false, true].map((unread) => {
          const id = `${group}-${unread ? 'unread' : 'read'}`
          const labels =
            group === 'spam'
              ? ['SPAM']
              : group === 'trash'
                ? ['TRASH']
                : group === 'normal'
                  ? ['INBOX', 'STARRED', 'SENT', 'Label_Filter']
                  : ['INBOX']
          return {
            id,
            messages: [
              {
                id: `m-${id}`,
                labelIds: [...labels, ...(unread ? ['UNREAD'] : [])],
                receivedDaysAgo: unread ? 1 : 0,
                from: 'Sender <sender@attn.test>',
                to: 'unread@attn.test',
                subject: id,
                bodyText: id
              }
            ]
          }
        })
      )
    })
  )
})

for (const theme of ['light', 'dark'] as const) {
  test(`filters mailboxes from the title row in ${theme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme })
    await expect(page.locator('html')).toHaveAttribute('data-theme-appearance', theme)
    await page.evaluate(() =>
      window.attn.mail.snooze(['snoozed-read', 'snoozed-unread'], Date.now() + 86400000)
    )
    const filter = page.getByTestId('mail-unread-filter')
    const rows = page.getByTestId('thread-row')
    await goTo(page, 's')
    await expect(page.getByTestId('view-title')).toHaveText('Starred')
    await expect(rows).toHaveCount(2)
    await expect(filter).toHaveAccessibleName('Show unread conversations')
    const titleBox = await page.getByTestId('mailbox-title').boundingBox()
    const filterBox = await filter.boundingBox()
    if (!titleBox || !filterBox) throw new Error('Mailbox header is missing')
    expect(filterBox.x - titleBox.x - titleBox.width).toBeGreaterThan(0)
    expect(filterBox.x - titleBox.x - titleBox.width).toBeLessThan(24)
    expect(Math.abs(filterBox.y + filterBox.height / 2 - titleBox.y - titleBox.height / 2)).toBeLessThan(2)
    await page.keyboard.press('Shift+U')
    await expect(rows).toHaveCount(1)
    await expect(rows).toContainText('normal-unread')
    mkdirSync(join(__dirname, '.artifacts'), { recursive: true })
    await page.getByTestId('mail-view-header').screenshot({
      path: join(__dirname, `.artifacts/unread-starred-header-${theme}.png`),
      animations: 'disabled'
    })
    for (const [chord, title, count] of [
      ['i', 'Inbox', 1],
      ['t', 'Sent', 1],
      ['a', 'All Mail', 2],
      ['p', 'Spam', 1],
      ['r', 'Trash', 1],
      ['h', 'Snoozed', 1]
    ] as const) {
      await goTo(page, chord)
      await expect(page.getByTestId('view-title')).toHaveText(title)
      await expect(filter).toHaveAttribute('aria-pressed', 'true')
      await expect(rows).toHaveCount(count)
      expect(
        await rows.evaluateAll((elements) =>
          elements.every((element) => element.getAttribute('data-unread') === 'true')
        )
      ).toBe(true)
    }
    await page.getByTestId('sidebar-label').filter({ hasText: 'Filter label' }).click()
    await expect(page.getByTestId('view-title')).toHaveText('Filter label')
    await expect(rows).toHaveCount(1)
    await filter.click()
    await expect(rows).toHaveCount(2)
    await goTo(page, 's')
    await expect(rows).toHaveCount(2)
    await filter.click()
    await expect(rows).toHaveCount(1)
    await page.keyboard.press('Enter')
    await expect(page.getByTestId('conversation-subject')).toHaveText('normal-unread')
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const result = await window.attn.mail.findThreadInView(
            { view: 'starred', unreadOnly: true },
            'normal-unread'
          )
          return result.rows.length
        })
      )
      .toBe(0)
    await flushRendererIpc(page)
    await expect(page.getByTestId('conversation-subject')).toHaveText('normal-unread')
    await page.keyboard.press('Escape')
    await expect(rows).toHaveCount(0)
    await expect(page.getByTestId('thread-list')).toContainText('No unread conversations')
    await goTo(page, 'd')
    await expect(filter).toHaveCount(0)
    await goTo(page, 'o')
    await expect(filter).toHaveCount(0)
  })
}
