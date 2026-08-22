import type { ElectronApplication } from '@playwright/test'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-inbox.json' })

interface ExistenceSweepResult {
  listedThreadCount: number
  deletedThreadIds: string[]
  error?: string
}

function runExistenceSweep(app: ElectronApplication): Promise<ExistenceSweepResult> {
  return app.evaluate(
    ({ ipcMain }, request) =>
      new Promise<ExistenceSweepResult>((resolve) =>
        ipcMain.emit(request.channel, {}, request.input, resolve)
      ),
    {
      channel: TEST_CHANNELS.runExistenceSweep,
      input: {
        // t-weekly is the server-purged fixture. t-roadmap appears in both the
        // default and Trash listings because only one of its messages is trashed.
        allMailThreadIds: [
          't-roadmap',
          't-receipt',
          't-design',
          't-lunch',
          't-budget',
          't-travel',
          't-research',
          't-sent-history'
        ],
        spamThreadIds: [],
        trashThreadIds: ['t-roadmap']
      }
    }
  )
}

test('removes a local ghost only after the account existence listings finish', async ({ app, page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  expect(await page.evaluate(() => window.attn.mail.getConversation('t-weekly', false))).not.toBeNull()

  await expect(runExistenceSweep(app)).resolves.toEqual({
    listedThreadCount: 8,
    deletedThreadIds: ['t-weekly']
  })

  await expect(page.getByTestId('thread-row')).toHaveCount(7)
  expect(await page.evaluate(() => window.attn.mail.getConversation('t-weekly', false))).toBeNull()
  expect(await page.evaluate(() => window.attn.mail.getConversation('t-sent-history', false))).not.toBeNull()
  expect(await page.evaluate(() => window.attn.mail.getConversation('t-roadmap', false))).not.toBeNull()
})
