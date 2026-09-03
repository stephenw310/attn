import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC_CHANNELS, TEST_CHANNELS } from '../src/shared/ipc'
import type { ThreadListRequest } from '../src/shared/mail'
import { expect, test } from './electron'

for (const view of ['inbox', 'split', 'all'] as const) {
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
      mkdirSync(join(__dirname, '.generated'), { recursive: true })
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

    for (const change of ['new mail', 'removed thread'] as const) {
      test(`restores after ${change} while the account is in the background`, async ({ app, page }) => {
        await expect(page.getByTestId('account-menu')).toContainText('primary@attn.test')
        if (view === 'split') {
          await page.locator('[data-testid="split-tab"][data-split-id="fallback:other"]').click()
        }
        if (view === 'all') {
          await page.keyboard.press('g')
          await page.keyboard.press('a')
          await expect(page.getByTestId('mailbox-title')).toHaveText('All Mail')
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
                  labelIds: ['INBOX'],
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
        await app.evaluate(
          ({ ipcMain }, channel) => new Promise<void>((resolve) => ipcMain.emit(channel, {}, resolve)),
          TEST_CHANNELS.reloadSeed
        )
        await app.evaluate(({ ipcMain }, channel) => {
          type Handler = Parameters<typeof ipcMain.handle>[1]
          const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })._invokeHandlers
          const original = handlers.get(channel)
          if (!original) throw new Error('Missing thread list handler')
          const requests: ThreadListRequest[] = []
          Object.assign(globalThis, { restoreRequests: requests })
          ipcMain.removeHandler(channel)
          ipcMain.handle(channel, (event, request) => {
            requests.push(request)
            return original(event, request)
          })
        }, IPC_CHANNELS.mailListThreads)
        await page.keyboard.press('ControlOrMeta+1')
        await expect(page.getByTestId('account-menu')).toContainText('primary@attn.test')
        await expect(selected).toHaveAttribute('data-thread-id', change === 'new mail' ? id : fallbackId)
        await expect(list).toHaveAttribute('data-thread-count', change === 'new mail' ? '200' : '100')
        const requests = await app.evaluate(
          () => (globalThis as unknown as { restoreRequests: ThreadListRequest[] }).restoreRequests
        )
        expect(requests.some((request) => request.threadId === id)).toBe(true)
        // A missing row must not trigger a scan of the remaining mailbox pages.
        expect(requests.filter((request) => request.cursor && !request.threadId)).toHaveLength(
          change === 'new mail' ? 1 : 0
        )
      })
    }
  })
}
