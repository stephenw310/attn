import type { ElectronApplication, Page } from '@playwright/test'
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
  pauseAtPageToken?: string
}

interface SweepResult {
  cursor: string | null
  error?: string
  formats: string[]
  pageTokens: Array<string | undefined>
}

function oldThread(id: string, year: number): GmailThread {
  return {
    id,
    messages: [
      {
        id: `message-${id}`,
        threadId: id,
        labelIds: ['SENT'],
        internalDate: String(Date.UTC(year, 0, 2)),
        snippet: `Utility crash fixture ${id}`,
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'Attn Seed <seed@attn.test>' },
            { name: 'To', value: `${id}@example.com` },
            { name: 'Subject', value: `Utility crash fixture ${id}` },
            { name: 'Message-ID', value: `<${id}@attn.test>` }
          ]
        }
      }
    ]
  }
}

function runSweep(app: ElectronApplication, request: SweepRequest): Promise<SweepResult> {
  return app.evaluate(
    ({ ipcMain }, { channel, input }) =>
      new Promise<SweepResult>((resolve) => ipcMain.emit(channel, {}, input, resolve)),
    { channel: TEST_CHANNELS.runLifetimeSweep, input: request }
  )
}

function crashUtility(app: ElectronApplication): Promise<void> {
  return app.evaluate(
    ({ ipcMain }, channel) =>
      new Promise<void>((resolve, reject) =>
        ipcMain.emit(channel, {}, (error?: string) => (error ? reject(new Error(error)) : resolve()))
      ),
    TEST_CHANNELS.crashUtility
  )
}

function utilityState(
  app: ElectronApplication,
  ids: string[]
): Promise<{
  threadCount: number
  messageCount: number
  cursors: { sweep_cursor: string | null }
}> {
  return app.evaluate(
    ({ ipcMain }, { channel, threadIds }) =>
      new Promise((resolve) => ipcMain.emit(channel, {}, threadIds, resolve)),
    { channel: TEST_CHANNELS.utilityState, threadIds: ids }
  )
}

async function conversationExists(page: Page, threadId: string): Promise<boolean> {
  return page.evaluate(async (id) => (await window.attn.mail.getConversation(id, false)) !== null, threadId)
}

test('restarts after a utility crash and resumes the persisted sweep cursor without duplicate rows', async ({
  app,
  page
}) => {
  const first = oldThread('t-utility-first', 2007)
  const second = oldThread('t-utility-second', 2008)
  const interrupted = runSweep(app, {
    resetCursor: 'lifetime',
    threads: [first, second],
    pages: [
      {
        threadIds: [first.id],
        nextPageToken: 'page-2',
        resultSizeEstimate: 2
      }
    ],
    pauseAtPageToken: 'page-2'
  })

  await expect.poll(() => conversationExists(page, first.id)).toBe(true)
  await crashUtility(app)
  expect(await interrupted).toMatchObject({ error: expect.stringContaining('exited') })

  const resumed = await runSweep(app, {
    threads: [first, second],
    pages: [{ pageToken: 'page-2', threadIds: [second.id], resultSizeEstimate: 2 }]
  })
  expect(resumed.cursor).toBe('done')
  await expect.poll(() => conversationExists(page, second.id)).toBe(true)
  expect(await utilityState(app, [first.id, second.id])).toMatchObject({
    threadCount: 2,
    messageCount: 2,
    cursors: { sweep_cursor: 'done' }
  })
})
