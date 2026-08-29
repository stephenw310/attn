import { describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../../shared/ipc'
import { openDatabase } from '../db'
import type { GmailThread } from '../gmail/parse'
import { ensureAccount } from '../sync/persist'
import type { ServerSearchProvider } from '../sync/serverSearch'
import type { SyncController } from '../syncController'
import { createServiceHandlers, type ServiceHandlerContext } from './handlers'

const ACCOUNT = 'search@example.test'

function handlerContext(
  db: ReturnType<typeof openDatabase>,
  provider: ServerSearchProvider,
  broadcastMailChanged = vi.fn(),
  syncController: SyncController | null = null
): ServiceHandlerContext {
  return {
    db,
    currentAccountId: () => ACCOUNT,
    makeClient: () => null,
    makeProvider: () => null,
    makeServerSearchProvider: () => provider,
    isSeeded: () => false,
    executor: () => null,
    draftMirrorExecutor: () => null,
    outboxSender: () => null,
    scheduler: () => null,
    syncController: () => syncController,
    broadcastMailChanged,
    broadcastOutboxChanged: vi.fn(),
    broadcastBodyHydrationFailed: vi.fn(),
    trackForegroundProviderWork: async <T>(_accountId: string, work: () => Promise<T>) => work(),
    peekRevertedActions: () => null,
    acknowledgeRevertedActions: () => false,
    waitForConversation: async () => undefined,
    draftReopenDelay: () => 0,
    draftInlineImageDelay: () => 0,
    consumeTestDraftSaveFailure: () => false,
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
    const controller = {
      getState: () => ({ phase: 'offline', message: 'offline' }),
      isInboxRecoveryPending: () => true
    } as unknown as SyncController
    const handlers = createServiceHandlers(handlerContext(db, emptyProvider, vi.fn(), controller))

    try {
      await expect(handlers.invoke(IPC_CHANNELS.syncGetInboxReady, [])).resolves.toBe(false)
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
