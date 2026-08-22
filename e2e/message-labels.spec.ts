import type { ElectronApplication } from '@playwright/test'
import { TEST_CHANNELS } from '../src/shared/ipc'
import type { MessageMailbox } from '../src/shared/mail'
import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-inbox.json' })

async function mailboxThreadIds(app: ElectronApplication, mailbox: MessageMailbox): Promise<string[]> {
  return app.evaluate(
    ({ ipcMain }, request) =>
      new Promise<string[]>((resolve, reject) => {
        ipcMain.emit(request.channel, {}, request.mailbox, (threadIds: string[], error?: string) =>
          error ? reject(new Error(error)) : resolve(threadIds)
        )
      }),
    { channel: TEST_CHANNELS.listMailboxThreadIds, mailbox }
  )
}

test('keeps a partially trashed thread in All Mail and Trash while the normal reader hides it', async ({
  app,
  page
}) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  expect(await mailboxThreadIds(app, 'all-mail')).toContain('t-roadmap')
  expect(await mailboxThreadIds(app, 'trash')).toContain('t-roadmap')
  expect(await mailboxThreadIds(app, 'spam')).not.toContain('t-roadmap')

  const roadmapRow = page.getByTestId('thread-row').filter({ hasText: 'Q3 roadmap review' })
  await expect(roadmapRow.getByTestId('thread-snippet')).toContainText('I added the launch milestones.')
  await expect(roadmapRow).not.toContainText('This deleted reply belongs only in Trash.')
  await roadmapRow.click()
  await expect(page.getByTestId('message-card')).toHaveCount(2)
  await expect(page.getByTestId('conversation-content')).not.toContainText(
    'This deleted reply belongs only in Trash.'
  )
  await expect(page.getByTestId('conversation-content')).not.toContainText(
    'This unsent Gmail draft must never render as a message.'
  )
})
