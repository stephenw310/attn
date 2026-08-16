import type { ElectronApplication } from '@playwright/test'
import type { GmailThread } from '../src/main/gmail/parse'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { expect, test } from './electron'

test.use({ seed: 'fixtures/seed-inbox.json' })

interface SweepRequest {
  resetCursor?: string
  threads: GmailThread[]
  pages: Array<{
    pageToken?: string
    threadIds: string[]
    nextPageToken?: string
    resultSizeEstimate?: number
  }>
  offlineAtPageToken?: string
  threadsTotal?: number
  messagesTotal?: number
}

interface SweepResult {
  cursor: string | null
  error?: string
  formats: string[]
  pageTokens: Array<string | undefined>
}

async function runSweep(app: ElectronApplication, request: SweepRequest): Promise<SweepResult> {
  return app.evaluate(
    ({ ipcMain }, { channel, input }) =>
      new Promise<SweepResult>((resolve) => ipcMain.emit(channel, {}, input, resolve)),
    { channel: TEST_CHANNELS.runLifetimeSweep, input: request }
  )
}

function oldSentThread(id: string, recipient: string, year: number): GmailThread {
  return {
    id,
    messages: [
      {
        id: `message-${id}`,
        threadId: id,
        labelIds: ['SENT'],
        internalDate: String(Date.UTC(year, 0, 2)),
        snippet: `A header-only note to ${recipient}`,
        payload: {
          mimeType: 'multipart/mixed',
          headers: [
            { name: 'From', value: 'Attn Seed <seed@attn.test>' },
            { name: 'To', value: recipient },
            { name: 'Subject', value: `Old correspondence from ${year}` },
            { name: 'Message-ID', value: `<${id}@attn.test>` }
          ]
        }
      }
    ]
  }
}

test('resumes a header-only lifetime sweep across offline relaunch without changing inbox unread', async ({
  boot,
  page
}) => {
  const firstThread = oldSentThread('t-lifetime-2009', 'Archive One <archive.one@example.com>', 2009)
  const secondThread = oldSentThread('t-lifetime-2011', 'Archive Two <archive.two@example.com>', 2011)
  const unreadBefore = await page.evaluate(() => window.attn.mail.getUnreadCount())

  const interrupted = await runSweep(boot.app, {
    resetCursor: 'lifetime',
    threads: [firstThread, secondThread],
    pages: [
      {
        threadIds: [firstThread.id],
        nextPageToken: 'page-2',
        resultSizeEstimate: 11
      }
    ],
    offlineAtPageToken: 'page-2',
    threadsTotal: 11,
    messagesTotal: 13
  })

  expect(interrupted).toEqual({
    cursor: 'lifetime:page-2',
    error: 'offline',
    formats: ['metadata'],
    pageTokens: [undefined, 'page-2']
  })
  expect(await page.evaluate(() => window.attn.mail.getUnreadCount())).toBe(unreadBefore)
  expect(await page.evaluate(() => window.attn.contacts.search('archive.one'))).toEqual([
    expect.objectContaining({ email: 'archive.one@example.com' })
  ])

  const relaunched = await boot.relaunch()
  const resumed = await runSweep(relaunched.app, {
    threads: [firstThread, secondThread],
    pages: [{ pageToken: 'page-2', threadIds: [secondThread.id], resultSizeEstimate: 11 }],
    threadsTotal: 11,
    messagesTotal: 13
  })

  expect(resumed).toEqual({
    cursor: 'done',
    formats: ['metadata'],
    pageTokens: ['page-2']
  })
  expect(await relaunched.page.evaluate(() => window.attn.mail.getUnreadCount())).toBe(unreadBefore)
  expect(
    await relaunched.page.evaluate(() => window.attn.mail.getConversation('t-lifetime-2011', false))
  ).toMatchObject({
    messages: [
      {
        bodyState: 'signed-out',
        bodyText: 'A header-only note to Archive Two <archive.two@example.com>'
      }
    ]
  })
  expect(await relaunched.page.evaluate(() => window.attn.contacts.search('archive.two'))).toEqual([
    expect.objectContaining({ email: 'archive.two@example.com' })
  ])
})
