import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from './electron'

for (const view of ['inbox', 'split', 'all'] as const) {
  test.describe(`account restoration in ${view}`, () => {
    const seed = `.artifacts/account-restore-${view}.json`
    test.use({ seed })
    test.beforeAll(() => {
      const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/seed-two-accounts.json'), 'utf8'))
      const primary = fixture.accounts[0]
      primary.splitSetup = view === 'split'
      primary.threads.push(
        ...Array.from({ length: 250 }, (_, index) => ({
          id: `t-restore-${index}`,
          messages: [
            {
              id: `m-restore-${index}`,
              labelIds: ['INBOX'],
              receivedDaysAgo: index + 2,
              receivedAt: '12:00',
              from: 'Sender <sender@example.test>',
              to: primary.account,
              subject: `Restoration row ${index}`,
              bodyText: `Body for restoration row ${index}`
            }
          ]
        }))
      )
      mkdirSync(join(__dirname, '.artifacts'), { recursive: true })
      writeFileSync(join(__dirname, seed), JSON.stringify(fixture))
    })

    test('restores selection beyond the first page and scroll on an account round trip', async ({ page }) => {
      await expect(page.getByTestId('account-menu')).toContainText('primary@attn.test')
      const split = page.locator('[data-testid="split-tab"][data-split-id="fallback:other"]')
      if (view === 'split') await split.click()
      if (view === 'all') {
        await page.keyboard.press('g')
        await page.keyboard.press('a')
        await expect(page.getByTestId('mailbox-title')).toHaveText('All Mail')
      }
      const list = page.getByTestId('thread-list')
      await expect(list).toHaveAttribute('data-thread-count', '100')
      await list.evaluate((element) => {
        element.scrollTop = element.scrollHeight
      })
      await expect(list).toHaveAttribute('data-thread-count', '200')
      await list.focus()
      for (let index = 0; index < 105; index++) await page.keyboard.press('j')
      const selected = page.locator('[data-testid="thread-row"][data-selected="true"]')
      await expect(selected).toHaveAttribute('data-thread-index', '105')
      const id = await selected.getAttribute('data-thread-id')
      if (!id) throw new Error('Selected thread missing')
      const scrollTop = await list.evaluate((element) => element.scrollTop)
      expect(scrollTop).toBeGreaterThan(0)
      await page.keyboard.press('ControlOrMeta+2')
      await expect(page.getByTestId('account-menu')).toContainText('second@attn.test')
      await page.keyboard.press('ControlOrMeta+1')
      await expect(page.getByTestId('account-menu')).toContainText('primary@attn.test')
      await expect(selected).toHaveAttribute('data-thread-id', id)
      await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBe(scrollTop)
      if (view === 'split') await expect(split).toHaveAttribute('data-active', 'true')
      if (view === 'all') await expect(page.getByTestId('mailbox-title')).toHaveText('All Mail')
    })
  })
}
