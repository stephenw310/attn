// E2E-only IPC seams, active solely under the ATTN_TEST_USER_DATA env seam.
// Extracted from index.ts (review R1) so the boot file stays production code:
// every attn:test:* handler and the mutable state behind the production-facing
// accessors live here. `TestSeams` is constructed disabled in production, where
// every accessor is inert and register() is a no-op.

import { ipcMain } from 'electron'
import { errorMessage } from '../shared/error'
import { nonEmptyString } from '../shared/guards'
import { TEST_CHANNELS } from '../shared/ipc'
import type { MessageMailbox, SyncState } from '../shared/mail'
import type { ActionExecutor, ActionRecoveryProvider } from './actions/executor'
import type { Db } from './db'
import { listMailboxThreadIds } from './db/queries'
import { loadSeed, readSeedThread } from './dev/seed'
import { GmailApiError } from './gmail/client'
import type { GmailThread } from './gmail/parse'
import { reconcileRemoteDraft } from './outbox/draftSync'
import { writeSetting } from './settings'
import { runLifetimeSweep } from './sync/lifetimeSweep'
import { deleteThread, type LabelRow } from './sync/persist'
import type { MailProvider } from './sync/provider'
import type { SyncController } from './syncController'

export interface TestSeamDeps {
  db: () => Db | null
  seedPath: () => string | undefined
  seedAccountId: () => string | null
  currentAccountId: () => string | null
  actionExecutor: () => ActionExecutor | null
  syncController: () => SyncController | null
  broadcastMailChanged: () => void
  focusInboxThread: (threadId: string) => void
}

interface LifetimeSweepRequest {
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

function isLabelRows(value: unknown): value is LabelRow[] {
  return (
    Array.isArray(value) &&
    value.every(
      (label) =>
        typeof label === 'object' &&
        label !== null &&
        typeof (label as LabelRow).id === 'string' &&
        typeof (label as LabelRow).name === 'string' &&
        typeof (label as LabelRow).type === 'string'
    )
  )
}

function isMessageMailbox(value: unknown): value is MessageMailbox {
  return value === 'all-mail' || value === 'spam' || value === 'trash'
}

export class TestSeams {
  private conversationDelay: { threadId: string; delayMs: number } | null = null
  private draftReopenDelayMs = 0
  private draftInlineImageDelayMs = 0
  private draftSaveFailures = 0
  /** Seeded provider that rejects one named action (failNextAction seams). */
  private actionProvider: ActionRecoveryProvider | null = null
  private attachmentPickerPaths: string[] | null = null

  constructor(
    private readonly enabled: boolean,
    private readonly deps: TestSeamDeps
  ) {}

  /** Delay one conversation read so specs can race reads against navigation. */
  async waitForConversation(threadId: string): Promise<void> {
    const delay = this.conversationDelay
    if (!this.enabled || delay?.threadId !== threadId) return
    await new Promise((resolve) => setTimeout(resolve, delay.delayMs))
  }

  /** The seeded provider that rejects one action, or null outside e2e. */
  provider(): ActionRecoveryProvider | null {
    return this.actionProvider
  }

  /**
   * The seeded e2e store has no OAuth config, so a reconnect click resumes the
   * seeded account instead of running the real flow. Production sign-in stays
   * free of test branching: disabled, this returns 0 and signIn proceeds.
   */
  seededResume(): number {
    if (!this.enabled) return 0
    const account = this.deps.seedAccountId()
    return account ? (this.deps.actionExecutor()?.resumeAuthFailures(account) ?? 0) : 0
  }

  draftReopenDelay(): number {
    return this.draftReopenDelayMs
  }

  draftInlineImageDelay(): number {
    return this.draftInlineImageDelayMs
  }

  consumeDraftSaveFailure(): boolean {
    if (this.draftSaveFailures === 0) return false
    this.draftSaveFailures--
    return true
  }

  takeAttachmentPickerPaths(): string[] {
    const paths = this.attachmentPickerPaths ?? []
    this.attachmentPickerPaths = null
    return paths
  }

  register(): void {
    if (!this.enabled) return
    ipcMain.on(TEST_CHANNELS.focusThread, (_event, threadId: unknown) => {
      if (nonEmptyString(threadId)) this.deps.focusInboxThread(threadId)
    })
    ipcMain.on(TEST_CHANNELS.setSyncState, (_event, state: SyncState) =>
      this.deps.syncController()?.setStateForTest(state)
    )
    ipcMain.on(
      TEST_CHANNELS.listMailboxThreadIds,
      (_event, mailbox: unknown, done?: (threadIds: string[], error?: string) => void) => {
        setImmediate(() => {
          try {
            const db = this.deps.db()
            const account = this.deps.currentAccountId()
            if (!db || !account || !isMessageMailbox(mailbox)) {
              done?.([], 'mailbox query unavailable')
              return
            }
            done?.(listMailboxThreadIds(db, account, mailbox))
          } catch (error) {
            done?.([], errorMessage(error))
          }
        })
      }
    )
    ipcMain.on(
      TEST_CHANNELS.reloadSeed,
      (_event, labelsOrDone: unknown, maybeDone?: (error?: string) => void) => {
        const done =
          typeof labelsOrDone === 'function' ? (labelsOrDone as (error?: string) => void) : maybeDone
        const labels = typeof labelsOrDone === 'function' ? undefined : labelsOrDone
        // Avoid re-entering better-sqlite3 if the renderer is finishing an IPC read
        // in the same turn, and let the test wait for the replay to commit.
        setImmediate(() => {
          try {
            const db = this.deps.db()
            const seedPath = this.deps.seedPath()
            if (!db || !seedPath) throw new Error('seed store unavailable')
            if (labels !== undefined && !isLabelRows(labels)) {
              throw new Error('invalid authoritative label catalog')
            }
            const result = loadSeed(db, seedPath, labels === undefined ? {} : { labels })
            if (result.labelsChanged) this.deps.broadcastMailChanged()
            done?.()
          } catch (error) {
            done?.(errorMessage(error))
          }
        })
      }
    )
    ipcMain.on(TEST_CHANNELS.deleteThread, (_event, threadId: unknown, done?: (error?: string) => void) => {
      // Inspector evaluation can interrupt a renderer-initiated synchronous
      // SQLite read. Defer this test mutation onto the next main-loop turn.
      setImmediate(() => {
        try {
          const db = this.deps.db()
          const account = this.deps.currentAccountId()
          if (!db || !account || typeof threadId !== 'string') {
            done?.('invalid thread delete')
            return
          }
          deleteThread(db, account, threadId)
          done?.()
        } catch (error) {
          done?.(errorMessage(error))
        }
      })
    })
    ipcMain.on(TEST_CHANNELS.delayConversation, (_event, threadId: unknown, delayMs: unknown) => {
      if (typeof threadId !== 'string' || typeof delayMs !== 'number' || delayMs < 0) return
      this.conversationDelay = { threadId, delayMs }
    })
    ipcMain.on(TEST_CHANNELS.delayDraftReopen, (_event, delayMs: unknown) => {
      this.draftReopenDelayMs = typeof delayMs === 'number' && delayMs >= 0 ? delayMs : 0
    })
    ipcMain.on(TEST_CHANNELS.delayDraftInlineImage, (_event, delayMs: unknown) => {
      this.draftInlineImageDelayMs = typeof delayMs === 'number' && delayMs >= 0 ? delayMs : 0
    })
    ipcMain.on(
      TEST_CHANNELS.updateMessageBody,
      (_event, messageId: unknown, bodyText: unknown, done?: (error?: string) => void) => {
        // electronApplication.evaluate can interrupt a synchronous SQLite read
        // in the inspector context. Queue the mutation onto the next main-loop
        // turn and let the test wait until the write and invalidation complete.
        setImmediate(() => {
          try {
            const db = this.deps.db()
            if (!db || typeof messageId !== 'string' || typeof bodyText !== 'string') {
              done?.('invalid message update')
              return
            }
            const account = this.deps.currentAccountId()
            if (!account) {
              done?.('account unavailable')
              return
            }
            db.prepare('UPDATE messages SET body_text = ? WHERE account_id = ? AND id = ?').run(
              bodyText,
              account,
              messageId
            )
            this.deps.broadcastMailChanged()
            done?.()
          } catch (error) {
            done?.(errorMessage(error))
          }
        })
      }
    )
    ipcMain.on(TEST_CHANNELS.failNextDraftSave, () => {
      this.draftSaveFailures++
    })
    ipcMain.on(TEST_CHANNELS.failNextAction, (_event, threadId: unknown) => {
      this.installActionFailure(threadId, 400)
    })
    ipcMain.on(TEST_CHANNELS.failNextActionAuth, (_event, threadId: unknown) => {
      this.installActionFailure(threadId, 401)
    })
    ipcMain.on(TEST_CHANNELS.setAttachmentPickerFiles, (_event, paths: unknown) => {
      this.attachmentPickerPaths = Array.isArray(paths)
        ? paths.filter((path): path is string => typeof path === 'string')
        : []
    })
    ipcMain.on(
      TEST_CHANNELS.markDraftMirrored,
      (_event, draftId: unknown, gmailDraftId?: unknown, done?: (error?: string) => void) => {
        // Inspector evaluation can interrupt a renderer-initiated synchronous
        // SQLite read. Defer this test mutation onto the next main-loop turn.
        setImmediate(() => {
          try {
            const db = this.deps.db()
            const account = this.deps.currentAccountId()
            if (!db || !account || typeof draftId !== 'string') {
              done?.('invalid mirrored draft update')
              return
            }
            db.prepare(
              `UPDATE outbox SET mirror_revision = local_revision,
               gmail_draft_id = COALESCE(?, gmail_draft_id)
               WHERE account_id = ? AND id = ? AND state IN ('composing', 'drafted')`
            ).run(typeof gmailDraftId === 'string' ? gmailDraftId : null, account, draftId)
            done?.()
          } catch (error) {
            done?.(errorMessage(error))
          }
        })
      }
    )
    ipcMain.on(TEST_CHANNELS.setUndoSendDelay, (_event, seconds: unknown) => {
      const db = this.deps.db()
      if (!db || typeof seconds !== 'number' || ![0, 5, 8, 10, 20, 30].includes(seconds)) return
      writeSetting(db, 'undoSendDelaySeconds', String(seconds))
    })
    ipcMain.on(
      TEST_CHANNELS.failOutbox,
      (_event, id: unknown, message: unknown, done?: (error?: string) => void) => {
        setImmediate(() => {
          try {
            const db = this.deps.db()
            const account = this.deps.currentAccountId()
            if (!db || !account || typeof id !== 'string' || typeof message !== 'string') {
              done?.('invalid outbox failure')
              return
            }
            const result = db
              .prepare(
                `UPDATE outbox SET state = 'failed', send_at = NULL, last_error = ?
                 WHERE account_id = ? AND id = ? AND state = 'queued'`
              )
              .run(message, account, id)
            done?.(result.changes > 0 ? undefined : 'queued message unavailable')
          } catch (error) {
            done?.(errorMessage(error))
          }
        })
      }
    )
    ipcMain.on(TEST_CHANNELS.remoteDraft, (_event, remote: unknown, done?: (error?: string) => void) => {
      // Inspector evaluation can interrupt a renderer-initiated SQLite read.
      // Defer this test-only reconciliation onto the next main-loop turn.
      setImmediate(() => {
        const db = this.deps.db()
        const account = this.deps.currentAccountId()
        if (!db || !account || !remote || typeof remote !== 'object') {
          done?.('invalid remote draft')
          return
        }
        void reconcileRemoteDraft(db, account, remote as Parameters<typeof reconcileRemoteDraft>[2])
          .then(() => {
            this.deps.broadcastMailChanged()
            done?.()
          })
          .catch((error: unknown) => {
            done?.(errorMessage(error))
          })
      })
    })
    ipcMain.on(
      TEST_CHANNELS.runLifetimeSweep,
      async (
        _event,
        request: LifetimeSweepRequest,
        done: (result: {
          cursor: string | null
          error?: string
          formats: string[]
          pageTokens: Array<string | undefined>
        }) => void
      ) => {
        const db = this.deps.db()
        const accountId = this.deps.currentAccountId()
        if (!db || !accountId || !request || !Array.isArray(request.threads)) {
          done({ cursor: null, error: 'invalid lifetime sweep request', formats: [], pageTokens: [] })
          return
        }
        if (request.resetCursor) {
          db.prepare(
            `UPDATE sync_state
             SET sweep_cursor = ?, sweep_threads_done = 0, sweep_threads_total = NULL
             WHERE account_id = ?`
          ).run(request.resetCursor, accountId)
        }
        const threads = new Map(request.threads.map((thread) => [thread.id, thread]))
        const formats: string[] = []
        const pageTokens: Array<string | undefined> = []
        let failure: unknown
        const provider = {
          getProfile: async () => ({
            emailAddress: accountId,
            historyId: 'test-history',
            threadsTotal: request.threadsTotal,
            messagesTotal: request.messagesTotal
          }),
          listThreadIds: async (options = {}) => {
            pageTokens.push(options.pageToken)
            if (
              request.offlineAtPageToken !== undefined &&
              options.pageToken === request.offlineAtPageToken
            ) {
              throw new Error('offline')
            }
            const page = request.pages.find((candidate) => candidate.pageToken === options.pageToken)
            if (!page) return { threadIds: [] }
            return page
          },
          getThread: async (id: string, options = {}) => {
            formats.push(options.format ?? 'full')
            const thread = threads.get(id)
            if (!thread) throw new Error(`missing test thread ${id}`)
            return thread
          }
        } as MailProvider
        await runLifetimeSweep(
          db,
          provider,
          accountId,
          {
            onProgress: () => {},
            onError: (error) => {
              failure = error
            }
          },
          { requestIntervalMs: 0, pagePauseMs: 0 }
        )
        const state = db.prepare('SELECT sweep_cursor FROM sync_state WHERE account_id = ?').get(accountId) as
          | { sweep_cursor: string | null }
          | undefined
        done({
          cursor: state?.sweep_cursor ?? null,
          ...(failure ? { error: errorMessage(failure) } : {}),
          formats,
          pageTokens
        })
      }
    )
  }

  /** Teardown counterpart of register(): remove listeners and reset seam state. */
  dispose(): void {
    for (const channel of Object.values(TEST_CHANNELS)) ipcMain.removeAllListeners(channel)
    this.conversationDelay = null
    this.draftReopenDelayMs = 0
    this.draftInlineImageDelayMs = 0
    this.draftSaveFailures = 0
    this.actionProvider = null
    this.attachmentPickerPaths = null
  }

  private installActionFailure(threadId: unknown, status: 400 | 401): void {
    const seedPath = this.deps.seedPath()
    if (!seedPath || typeof threadId !== 'string') return
    const snapshot = readSeedThread(seedPath, threadId)
    if (!snapshot) return
    let rejectTarget = true
    const mutate = async (requestedThreadId: string): Promise<void> => {
      if (requestedThreadId !== threadId) return
      if (!rejectTarget) {
        if (status === 401) this.actionProvider = null
        return
      }
      rejectTarget = false
      const reason = status === 401 ? 'authentication e2e failure' : 'permanent e2e failure'
      throw new GmailApiError(status, `gmail /threads/${threadId}/modify failed (${status}): ${reason}`)
    }
    this.actionProvider = {
      modifyThread: mutate,
      trashThread: mutate,
      untrashThread: mutate,
      getThread: async (requestedThreadId) => {
        const requested = readSeedThread(seedPath, requestedThreadId)
        if (!requested) throw new GmailApiError(404, 'seed thread unavailable')
        if (requestedThreadId === threadId) this.actionProvider = null
        return requested
      }
    }
  }
}
