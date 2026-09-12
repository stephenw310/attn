import { describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../../shared/ipc'
import { openDatabase } from '../db'
import { countSystemMailboxes } from '../db/queries'
import type { GmailThread } from '../gmail/parse'
import { writeSetting } from '../settings'
import { getSplitState } from '../splits'
import { ensureAccount, persistThread } from '../sync/persist'
import type { ServerSearchProvider } from '../sync/serverSearch'
import type { SyncController } from '../syncController'
import { systemTime } from '../time'
import { createServiceHandlers, type ServiceHandlerContext } from './handlers'
import type { ServiceSession } from './session'
import type { TestHooks } from './testOperations'

/** The harness hooks default to production behavior; a test overrides one. */
function defaultTestHooks(): TestHooks {
  return {
    waitForConversation: async () => undefined,
    draftReopenDelayMs: () => 0,
    draftInlineImageDelayMs: () => 0,
    consumeDraftSaveFailure: () => false,
    searchWindowOverride: () => null
  }
}

const ACCOUNT = 'search@example.test'

function handlerContext(
  db: ReturnType<typeof openDatabase>,
  provider: ServerSearchProvider,
  broadcastMailChanged = vi.fn(),
  syncController: SyncController | null = null,
  testHooks: TestHooks = defaultTestHooks()
): ServiceHandlerContext {
  return {
    time: systemTime,
    db,
    currentAccountId: () => ACCOUNT,
    accountStatuses: () => [],
    publishRemoteImagePolicy: () => {},
    mailboxCounts: (accountId) => countSystemMailboxes(db, accountId),
    splitState: (accountId) => getSplitState(db, accountId),
    makeClient: () => null,
    makeProvider: () => null,
    makeServerSearchProvider: () => provider,
    activeSession: () => (syncController ? ({ syncController } as unknown as ServiceSession) : null),
    broadcastMailChanged,
    broadcastOutboxChanged: vi.fn(),
    broadcastBodyHydrationFailed: vi.fn(),
    trackForegroundProviderWork: async <T>(_accountId: string, work: () => Promise<T>) => work(),
    peekRevertedActions: () => null,
    acknowledgeRevertedActions: () => false,
    test: testHooks,
    testUserData: false,
    userDataPath: '/tmp/attn-test-user-data',
    downloadsPath: '/tmp/attn-test-downloads'
  }
}

function thread(id: string): GmailThread {
  return {
    id,
    messages: [
      {
        id: `message-${id}`,
        threadId: id,
        labelIds: ['INBOX'],
        internalDate: '100',
        snippet: 'Partial server result',
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: 'Remote Sender <remote@example.test>' },
            { name: 'To', value: ACCOUNT },
            { name: 'Subject', value: 'Partial server result' }
          ],
          body: { data: Buffer.from('Partial server result').toString('base64url') }
        }
      }
    ]
  }
}

const emptyProvider: ServerSearchProvider = {
  listThreadIds: vi.fn(async () => ({ threadIds: [] })),
  getThread: vi.fn(),
  getAttachmentData: vi.fn(async () => undefined)
}

describe('retired theme preferences', () => {
  it('reads old saved themes as Light or Dark and rejects new writes of retired themes', async () => {
    const db = openDatabase(':memory:')
    const handlers = createServiceHandlers(handlerContext(db, emptyProvider))
    try {
      for (const [oldTheme, theme] of [
        ['sand', 'dispatch-light'],
        ['midnight', 'dispatch-dark']
      ]) {
        writeSetting(db, 'theme', oldTheme)
        await expect(handlers.invoke(IPC_CHANNELS.settingsGetTheme, [])).resolves.toBe(theme)
        await expect(handlers.invoke(IPC_CHANNELS.settingsSetTheme, [oldTheme])).rejects.toThrow(
          'invalid theme preference'
        )
      }
    } finally {
      handlers.stop()
      db.close()
    }
  })
})

describe('message-specific reply service handler', () => {
  it('returns unavailable if the selected message disappears while waiting for the conversation', async () => {
    const db = openDatabase(':memory:')
    ensureAccount(db, ACCOUNT, ACCOUNT)
    const original = thread('source')
    const newer = thread('other').messages?.[0]
    if (!newer) throw new Error('missing fixture message')
    newer.threadId = 'source'
    persistThread(db, ACCOUNT, { ...original, messages: [...(original.messages ?? []), newer] })
    const hooks = defaultTestHooks()
    hooks.waitForConversation = async () => {
      db.prepare('DELETE FROM messages WHERE account_id = ? AND id = ?').run(ACCOUNT, 'message-source')
    }
    const context = handlerContext(db, emptyProvider, undefined, null, hooks)
    const handlers = createServiceHandlers(context)
    try {
      await expect(
        handlers.invoke(IPC_CHANNELS.draftCreateReply, ['source', 'reply', 'normal', 'message-source'])
      ).resolves.toBeNull()
      expect(db.prepare('SELECT COUNT(*) AS count FROM outbox').get()).toEqual({ count: 0 })
    } finally {
      handlers.stop()
      db.close()
    }
  })
})

describe('Inbox readiness service handler', () => {
  it('waits for both the full-body walk and the split metadata rebuild', async () => {
    const db = openDatabase(':memory:')
    ensureAccount(db, ACCOUNT, ACCOUNT)
    const setCursors = db.prepare(
      `INSERT INTO sync_state (account_id, backfill_cursor, split_metadata_cursor)
       VALUES (?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET
         backfill_cursor = excluded.backfill_cursor,
         split_metadata_cursor = excluded.split_metadata_cursor`
    )
    const handlers = createServiceHandlers(handlerContext(db, emptyProvider))

    try {
      setCursors.run(ACCOUNT, 'bodies', 'done')
      await expect(handlers.invoke(IPC_CHANNELS.syncGetInboxReady, [])).resolves.toBe(false)

      setCursors.run(ACCOUNT, 'drafts', 'split-metadata')
      await expect(handlers.invoke(IPC_CHANNELS.syncGetInboxReady, [])).resolves.toBe(false)

      setCursors.run(ACCOUNT, 'drafts', 'done')
      await expect(handlers.invoke(IPC_CHANNELS.syncGetInboxReady, [])).resolves.toBe(true)

      setCursors.run(ACCOUNT, 'unknown', 'done')
      await expect(handlers.invoke(IPC_CHANNELS.syncGetInboxReady, [])).rejects.toThrow(
        'Invalid backfill cursor: unknown'
      )
    } finally {
      handlers.stop()
      db.close()
    }
  })

  it('keeps readiness blocked while a failed history recovery awaits retry', async () => {
    const db = openDatabase(':memory:')
    ensureAccount(db, ACCOUNT, ACCOUNT)
    db.prepare(
      `INSERT INTO sync_state (account_id, backfill_cursor, split_metadata_cursor)
       VALUES (?, 'done', 'done')`
    ).run(ACCOUNT)
    const getState = vi.fn(() => ({ phase: 'offline', message: 'offline' }) as const)
    const controller = {
      getState,
      isInboxRecoveryPending: () => true
    } as unknown as SyncController
    const handlers = createServiceHandlers(handlerContext(db, emptyProvider, vi.fn(), controller))

    try {
      await expect(handlers.invoke(IPC_CHANNELS.syncGetInboxReady, [])).resolves.toBe(false)
      expect(getState).not.toHaveBeenCalled()
    } finally {
      handlers.stop()
      db.close()
    }
  })
})

describe('server-search service handlers', () => {
  it('aborts a pending provider request when the renderer cancels it', async () => {
    const db = openDatabase(':memory:')
    ensureAccount(db, ACCOUNT, ACCOUNT)
    let started: (() => void) | undefined
    const requestStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    let providerSignal: AbortSignal | undefined
    const provider: ServerSearchProvider = {
      listThreadIds: vi.fn(
        (options = {}) =>
          new Promise<never>((_, reject) => {
            providerSignal = options.signal
            started?.()
            options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
          })
      ),
      getThread: vi.fn(),
      getAttachmentData: vi.fn()
    }
    const handlers = createServiceHandlers(handlerContext(db, provider))

    try {
      const pending = handlers.invoke(IPC_CHANNELS.mailSearchAll, ['request-1', 'remote'])
      await requestStarted

      await handlers.invoke(IPC_CHANNELS.mailCancelSearchAll, ['request-1'])

      expect(providerSignal?.aborted).toBe(true)
      await expect(pending).resolves.toEqual({ status: 'ok', rows: [], quotaWaitMs: 0 })
    } finally {
      handlers.stop()
      db.close()
    }
  })

  it('broadcasts partial cache writes even when a later provider request fails', async () => {
    const db = openDatabase(':memory:')
    ensureAccount(db, ACCOUNT, ACCOUNT)
    const broadcastMailChanged = vi.fn()
    const provider: ServerSearchProvider = {
      listThreadIds: vi.fn(async () => ({ threadIds: ['stored', 'failed'] })),
      getThread: vi.fn(async (threadId) => {
        if (threadId === 'failed') throw new Error('provider failed after one durable result')
        return thread(threadId)
      }),
      getAttachmentData: vi.fn(async () => undefined)
    }
    const handlers = createServiceHandlers(handlerContext(db, provider, broadcastMailChanged))

    try {
      await expect(
        handlers.invoke(IPC_CHANNELS.mailSearchAll, ['request-partial', 'Partial'])
      ).resolves.toEqual({ status: 'error', message: 'Gmail search could not be completed' })
      expect(db.prepare('SELECT id FROM threads WHERE account_id = ?').all(ACCOUNT)).toEqual([
        { id: 'stored' }
      ])
      expect(broadcastMailChanged).toHaveBeenCalledOnce()
      expect(broadcastMailChanged).toHaveBeenCalledWith('request-partial')
    } finally {
      handlers.stop()
      db.close()
    }
  })
})

describe('search coverage', () => {
  const noProvider: ServerSearchProvider = {
    listThreadIds: vi.fn(),
    getThread: vi.fn(),
    getAttachmentData: vi.fn()
  }

  it('reads current search coverage after cursor-only sync progress', async () => {
    const db = openDatabase(':memory:')
    ensureAccount(db, ACCOUNT, ACCOUNT)
    const handlers = createServiceHandlers(handlerContext(db, noProvider))
    try {
      db.prepare('INSERT INTO sync_state (account_id, backfill_cursor) VALUES (?, ?)').run(ACCOUNT, 'bodies')
      expect((await handlers.invoke(IPC_CHANNELS.mailSearch, ['body'])).coverage).toEqual({
        headersComplete: false,
        headersCapped: false,
        indexComplete: false,
        attachmentFlagsComplete: false,
        bodiesOnDemand: false
      })
      db.prepare(
        `UPDATE sync_state SET backfill_cursor = 'all-mail', sweep_cursor = 'capped:lifetime',
                               fts_cursor = 'done', attachment_cursor = 'done'
         WHERE account_id = ?`
      ).run(ACCOUNT)
      expect((await handlers.invoke(IPC_CHANNELS.mailSearch, ['body'])).coverage).toEqual({
        headersComplete: false,
        headersCapped: true,
        indexComplete: true,
        attachmentFlagsComplete: true,
        bodiesOnDemand: true
      })
      db.prepare("UPDATE sync_state SET sweep_cursor = 'done' WHERE account_id = ?").run(ACCOUNT)
      expect((await handlers.invoke(IPC_CHANNELS.mailSearch, ['body'])).coverage).toMatchObject({
        headersComplete: true,
        headersCapped: false
      })
    } finally {
      handlers.stop()
      db.close()
    }
  })
})

describe('inbox thread pages', () => {
  it('pages every returned follow-up out across pages instead of capping at page one', async () => {
    const db = openDatabase(':memory:')
    ensureAccount(db, ACCOUNT, ACCOUNT)
    const insertThread = db.prepare(
      `INSERT INTO threads
       (account_id, id, subject, last_msg_at, from_display, is_unread, is_starred, has_attachment)
       VALUES (?, ?, ?, ?, 'Ana', 0, 0, 0)`
    )
    const insertLabel = db.prepare(
      "INSERT INTO thread_labels (account_id, thread_id, label_id) VALUES (?, ?, 'INBOX')"
    )
    const insertReminder = db.prepare(
      `INSERT INTO reminders (account_id, thread_id, kind, due_at, state)
       VALUES (?, ?, 'follow_up', ?, 'returned')`
    )
    const followUpIds: string[] = []
    for (let index = 0; index < 102; index++) {
      const id = `follow-${String(index).padStart(3, '0')}`
      followUpIds.push(id)
      insertThread.run(ACCOUNT, id, id, 1_000 + index)
      insertLabel.run(ACCOUNT, id)
      insertReminder.run(ACCOUNT, id, 900_000 - index)
    }
    insertThread.run(ACCOUNT, 'plain-newer', 'Plain newer', 2_000_000)
    insertLabel.run(ACCOUNT, 'plain-newer')
    insertThread.run(ACCOUNT, 'plain-older', 'Plain older', 1_000_000)
    insertLabel.run(ACCOUNT, 'plain-older')
    const handlers = createServiceHandlers(handlerContext(db, emptyProvider))

    try {
      // 102 returned follow-ups: page one is all tier and continues INSIDE the
      // tier (PR #101 review: the wholesale prepend returned 100 rows and then
      // an empty page two, silently hiding the overflow).
      const first = await handlers.invoke(IPC_CHANNELS.mailListThreads, [{ view: 'inbox' }])
      expect(first.rows).toHaveLength(100)
      expect(first.rows.every((row) => row.followUpReturned === true)).toBe(true)
      expect(first.nextCursor).toMatchObject({ tier: 'followUp' })

      const second = await handlers.invoke(IPC_CHANNELS.mailListThreads, [
        { view: 'inbox', cursor: first.nextCursor }
      ])
      expect(second.rows.map((row) => row.id)).toEqual([
        followUpIds[100],
        followUpIds[101],
        'plain-newer',
        'plain-older'
      ])
      expect(second.nextCursor).toBeNull()

      const seen = [...first.rows, ...second.rows].map((row) => row.id)
      expect(new Set(seen).size).toBe(seen.length)
      expect(seen).toHaveLength(104)
    } finally {
      handlers.stop()
      db.close()
    }
  })
})
