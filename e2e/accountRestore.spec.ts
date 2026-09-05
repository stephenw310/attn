import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC_CHANNELS, TEST_CHANNELS } from '../src/shared/ipc'
import type { ThreadListRequest } from '../src/shared/mail'
import { expect, test } from './electron'
import { emitSeam, expectResponseHeld, holdNextResponse, observeInvokes } from './seams'

for (const view of ['inbox', 'split', 'all', 'spam'] as const) {
  test.describe(`account restoration in ${view}`, () => {
    // A generated 250-thread seed, not a test artifact: `.artifacts/` is
    // uploaded wholesale by CI, `.generated/` is gitignored and stays local.
    const seed = `.generated/account-restore-${view}.json`
    test.use({ seed })
    test.beforeEach(() => {
      const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/seed-two-accounts.json'), 'utf8'))
      const primary = fixture.accounts[0]
      primary.splitSetup = view === 'split'
      primary.threads.push(
        ...Array.from({ length: 250 }, (_, index) => ({
          id: `t-restore-${index}`,
          messages: [
            {
              id: `m-restore-${index}`,
              labelIds: [view === 'spam' ? 'SPAM' : 'INBOX'],
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
      mkdirSync(join(__dirname, '.generated'), { recursive: true })
      writeFileSync(join(__dirname, seed), JSON.stringify(fixture))
    })

    test('restores selection beyond the first page and scroll on an account round trip', async ({ page }) => {
      await expect(page.getByTestId('account-menu')).toContainText('primary@attn.test')
      const split = page.locator('[data-testid="split-tab"][data-split-id="fallback:other"]')
      if (view === 'split') await split.click()
      if (view === 'all' || view === 'spam') {
        await page.keyboard.press('g')
        await page.keyboard.press(view === 'spam' ? 'p' : 'a')
        await expect(page.getByTestId('mailbox-title')).toHaveText(view === 'spam' ? 'Spam' : 'All Mail')
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
      if (view === 'all' || view === 'spam')
        await expect(page.getByTestId('mailbox-title')).toHaveText(view === 'spam' ? 'Spam' : 'All Mail')
    })

    if (view === 'spam') {
      test('shows loading while restoring Spam after an account switch', async ({ app, page }) => {
        await expect(page.getByTestId('thread-row')).toHaveCount(2)
        await page.keyboard.press('g')
        await page.keyboard.press('p')
        await expect(page.getByTestId('thread-list')).toHaveAttribute('data-thread-count', '100')
        await page.keyboard.press('ControlOrMeta+2')
        await expect(page.getByTestId('account-menu')).toContainText('second@attn.test')
        await expect(page.getByTestId('thread-row')).toHaveCount(2)
        const release = await holdNextResponse(app, IPC_CHANNELS.mailListThreads)
        await page.keyboard.press('ControlOrMeta+1')
        await expectResponseHeld(app)
        try {
          await expect(page.getByTestId('mailbox-title')).toHaveText('Spam')
          await expect(page.getByTestId('thread-list-loading-initial')).toBeVisible()
          await expect(page.getByText('Spam is empty', { exact: true })).toHaveCount(0)
          mkdirSync(join(__dirname, '.artifacts'), { recursive: true })
          await page.screenshot({ path: join(__dirname, '.artifacts/spam-loading.png') })
        } finally {
          await release()
        }
        await expect(page.getByTestId('thread-list')).toHaveAttribute('data-thread-count', '100')
        await expect(page.getByTestId('thread-list-loading-initial')).toHaveCount(0)
        await page.screenshot({ path: join(__dirname, '.artifacts/spam.png') })
      })
    }

    for (const change of ['new mail', 'removed thread'] as const) {
      test(`restores after ${change} while the account is in the background`, async ({ app, page }) => {
        await expect(page.getByTestId('account-menu')).toContainText('primary@attn.test')
        if (view === 'split') {
          await page.locator('[data-testid="split-tab"][data-split-id="fallback:other"]').click()
        }
        if (view === 'all' || view === 'spam') {
          await page.keyboard.press('g')
          await page.keyboard.press(view === 'spam' ? 'p' : 'a')
          await expect(page.getByTestId('mailbox-title')).toHaveText(view === 'spam' ? 'Spam' : 'All Mail')
        }
        const list = page.getByTestId('thread-list')
        await expect(list).toHaveAttribute('data-thread-count', '100')
        await list.focus()
        await page.keyboard.press('j')
        const selected = page.locator('[data-testid="thread-row"][data-selected="true"]')
        await expect(selected).toHaveAttribute('data-thread-index', '1')
        const id = await selected.getAttribute('data-thread-id')
        const fallbackId = await page
          .locator('[data-testid="thread-row"][data-thread-index="2"]')
          .getAttribute('data-thread-id')
        if (!id || !fallbackId) throw new Error('Restoration rows missing')
        await page.keyboard.press('ControlOrMeta+2')
        await expect(page.getByTestId('account-menu')).toContainText('second@attn.test')

        const fixture = JSON.parse(readFileSync(join(__dirname, seed), 'utf8'))
        const primary = fixture.accounts[0]
        if (change === 'new mail') {
          primary.threads.push(
            ...Array.from({ length: 110 }, (_, index) => ({
              id: `t-new-${index}`,
              messages: [
                {
                  id: `m-new-${index}`,
                  labelIds: [view === 'spam' ? 'SPAM' : 'INBOX'],
                  receivedDaysAgo: 0,
                  receivedAt: '10:00',
                  from: 'Sender <sender@example.test>',
                  to: primary.account,
                  subject: `New mail ${index}`,
                  bodyText: 'Mail received while this account was in the background'
                }
              ]
            }))
          )
        } else {
          const thread = primary.threads.find((thread: { id: string }) => thread.id === id)
          for (const message of thread.messages) message.labelIds = ['TRASH']
        }
        writeFileSync(join(__dirname, seed), JSON.stringify(fixture))
        await emitSeam(app, TEST_CHANNELS.reloadSeed)
        const listCalls = await observeInvokes(app, IPC_CHANNELS.mailListThreads)
        await page.keyboard.press('ControlOrMeta+1')
        await expect(page.getByTestId('account-menu')).toContainText('primary@attn.test')
        await expect(selected).toHaveAttribute('data-thread-id', change === 'new mail' ? id : fallbackId)
        await expect(list).toHaveAttribute('data-thread-count', change === 'new mail' ? '200' : '100')
        const requests = (await listCalls()).map(([request]) => request as ThreadListRequest)
        expect(requests.some((request) => request.threadId === id)).toBe(true)
        // A missing row must not trigger a scan of the remaining mailbox pages.
        expect(requests.filter((request) => request.cursor && !request.threadId)).toHaveLength(
          change === 'new mail' ? 1 : 0
        )
      })
    }
  })
}
