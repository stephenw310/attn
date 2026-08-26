import { describe, expect, it, vi } from 'vitest'
import { IPC_CHANNELS } from '../../shared/ipc'
import { openDatabase } from '../db'
import { ensureAccount } from '../sync/persist'
import type { ServerSearchProvider } from '../sync/serverSearch'
import { createServiceHandlers, type ServiceHandlerContext } from './handlers'

const ACCOUNT = 'search@example.test'

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
    const context: ServiceHandlerContext = {
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
      syncController: () => null,
      broadcastMailChanged: vi.fn(),
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
    const handlers = createServiceHandlers(context)

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
})
