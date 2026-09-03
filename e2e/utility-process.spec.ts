import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@playwright/test'
import { TEST_CHANNELS } from '../src/shared/ipc'
import { expect, test } from './electron'
import { runExistenceSweep, runSweep, oldThread as sweepThread } from './seams'

test.use({ seed: 'fixtures/seed-inbox.json' })

const oldThread = (id: string, year: number) => sweepThread(id, `${id}@example.com`, year)

function crashUtilityRaw(app: ElectronApplication): Promise<string | undefined> {
  return app.evaluate(
    ({ ipcMain }, channel) =>
      new Promise<string | undefined>((resolve) => ipcMain.emit(channel, {}, resolve)),
    TEST_CHANNELS.crashUtility
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
  cursors: { sweep_cursor: string | null; fts_cursor: string | null }
}> {
  return app.evaluate(
    ({ ipcMain }, { channel, threadIds }) =>
      new Promise((resolve) => ipcMain.emit(channel, {}, threadIds, resolve)),
    { channel: TEST_CHANNELS.utilityState, threadIds: ids }
  )
}

interface FtsBackfillResult {
  cursor: string | null
  indexed: number | null
  parity: { messages: number; mapped: number; ftsRows: number }
  error?: string
}

function runFtsBackfill(
  app: ElectronApplication,
  request: { resetIndex?: boolean; batchSize?: number; pauseAfterBatches?: number }
): Promise<FtsBackfillResult> {
  return app.evaluate(
    ({ ipcMain }, { channel, input }) =>
      new Promise<FtsBackfillResult>((resolve) => ipcMain.emit(channel, {}, input, resolve)),
    { channel: TEST_CHANNELS.runFtsBackfill, input: request }
  )
}

async function conversationExists(page: Page, threadId: string): Promise<boolean> {
  return page.evaluate(
    async (id) => (await window.attn.mail.getConversation(id, false, 'normal')) !== null,
    threadId
  )
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

test('resumes the FTS backfill from its persisted cursor after a utility crash, without duplicates', async ({
  app
}) => {
  const BATCH_SIZE = 4
  // Reproduce a manually upgraded revision-18 profile — stored messages, empty
  // index — then pause after the first committed batch and kill the process.
  const interrupted = runFtsBackfill(app, {
    resetIndex: true,
    batchSize: BATCH_SIZE,
    pauseAfterBatches: 1
  })
  await expect.poll(async () => (await utilityState(app, [])).cursors.fts_cursor).toMatch(/^fts:/)
  await crashUtility(app)
  expect(await interrupted).toMatchObject({ error: expect.stringContaining('exited') })

  const resumed = await runFtsBackfill(app, {})
  expect(resumed.cursor).toBe('done')
  // Only the remainder is indexed: the pass resumed instead of restarting.
  expect(resumed.indexed).toBe(resumed.parity.messages - BATCH_SIZE)
  expect(resumed.parity.mapped).toBe(resumed.parity.messages)
  expect(resumed.parity.ftsRows).toBe(resumed.parity.mapped)
  expect((await utilityState(app, [])).cursors.fts_cursor).toBe('done')
})

test('resumes a capped lifetime page after relaunch when the limit is raised or disabled', async ({
  app,
  page,
  boot
}) => {
  const fixture = JSON.parse(readFileSync(join(__dirname, 'fixtures/seed-inbox.json'), 'utf8')) as {
    threads: { id: string }[]
  }
  const before = await utilityState(
    app,
    fixture.threads.map((thread) => thread.id)
  )
  expect(before.threadCount).toBe(fixture.threads.length)
  const first = oldThread('t-capped-first', 2009)
  const second = oldThread('t-capped-second', 2008)
  const third = oldThread('t-capped-third', 2007)
  const request = {
    threads: [first, second, third],
    pages: [
      { pageToken: 'page-2', threadIds: [first.id, second.id], nextPageToken: 'page-3' },
      { pageToken: 'page-3', threadIds: [third.id] }
    ]
  }
  const cap = before.threadCount + 1
  expect(await runSweep(app, { ...request, resetCursor: 'lifetime:page-2', threadCap: cap })).toEqual({
    cursor: 'capped:lifetime:page-2',
    formats: ['metadata'],
    pageTokens: ['page-2']
  })
  await page.getByTestId('search-open').click()
  await page.getByTestId('search-input').fill('Utility')
  await expect(page.getByTestId('search-coverage')).toContainText(
    'Older headers are outside the local sync limit'
  )
  await expect(page.getByTestId('search-coverage')).not.toContainText('Older headers are still syncing')
  await page.screenshot({ path: join(__dirname, '.artifacts/search-capped.png') })

  const relaunched = await boot.relaunch()
  expect(await runSweep(relaunched.app, { ...request, threadCap: cap })).toEqual({
    cursor: 'capped:lifetime:page-2',
    formats: [],
    pageTokens: []
  })
  expect(await runSweep(relaunched.app, { ...request, threadCap: cap + 1 })).toEqual({
    cursor: 'capped:lifetime:page-3',
    formats: ['metadata'],
    pageTokens: ['page-2', 'page-3']
  })
  expect(await runSweep(relaunched.app, { ...request, threadCap: 0 })).toEqual({
    cursor: 'done',
    formats: ['metadata'],
    pageTokens: ['page-3']
  })
  expect(await utilityState(relaunched.app, [first.id, second.id, third.id])).toMatchObject({
    threadCount: 3,
    messageCount: 3,
    cursors: { sweep_cursor: 'done' }
  })
})

test('surfaces a crash-looped utility to a window that reads sync state after it died', async ({
  app,
  page
}) => {
  // The supervisor tolerates four crashes inside its rolling window and gives up
  // on the fifth. Each of the first four has to reach `ready` again before the
  // next kill counts, so drive them one at a time rather than in parallel.
  for (let attempt = 1; attempt <= 4; attempt++) {
    expect(await crashUtilityRaw(app), `crash ${attempt} should recover`).toBeUndefined()
  }
  expect(await crashUtilityRaw(app)).toContain('crashes within')

  // Live windows learn from the one-shot broadcast.
  await expect(page.getByTestId('status-note')).toHaveAttribute('data-status', 'error')
  await page.getByTestId('status-error-button').click()
  await expect(page.getByTestId('status-error-message')).toContainText('Mail service stopped')

  // A window mounting now has no broadcast to catch, so it seeds from this read.
  // Forwarded to the dead utility it would reject and leave the banner idle.
  expect(await page.evaluate(() => window.attn.sync.getState())).toEqual({
    phase: 'error',
    message: 'Mail service stopped after repeated crashes. Restart Attn.'
  })
})

// Moved here from a spec of its own (T5): the sibling sweep seams and the same
// seeded store already boot in this file, so the expiry pass shares that boot.
test('removes a local ghost only after the account existence listings finish', async ({ app, page }) => {
  await expect(page.getByTestId('thread-row')).toHaveCount(8)
  expect(
    await page.evaluate(() => window.attn.mail.getConversation('t-weekly', false, 'normal'))
  ).not.toBeNull()

  await expect(
    runExistenceSweep(app, {
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
        't-sent-history',
        't-starred-archive'
      ],
      spamThreadIds: [],
      trashThreadIds: ['t-roadmap']
    })
  ).resolves.toEqual({
    listedThreadCount: 9,
    deletedThreadIds: ['t-weekly']
  })

  await expect(page.getByTestId('thread-row')).toHaveCount(7)
  expect(await page.evaluate(() => window.attn.mail.getConversation('t-weekly', false, 'normal'))).toBeNull()
  expect(
    await page.evaluate(() => window.attn.mail.getConversation('t-sent-history', false, 'normal'))
  ).not.toBeNull()
  expect(
    await page.evaluate(() => window.attn.mail.getConversation('t-roadmap', false, 'normal'))
  ).not.toBeNull()
})
