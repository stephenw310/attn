// Every utility-side e2e seam (REF-6). AGENTS.md keeps main's seams in
// `testIpc.ts`; this is the same isolation for the utility half, so
// `ServiceRuntime` holds production behavior only and reaches the harness
// through the single `TestOperations` object it constructs under
// ATTN_TEST_USER_DATA and nowhere else.
//
// Seams run production code wherever they can — the history cycle, the
// lifetime and existence sweeps, the FTS backfill, and the send protocol all
// execute the shipped modules against supplied fixtures, so an e2e cannot pass
// against a simulation of the behavior it is asserting.

import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { TEST_CHANNELS } from '../../shared/ipc'
import { type MessageMailbox, type SyncState, THREAD_PAGE_SIZE } from '../../shared/mail'
import { ALLOWED_UNDO_SEND_SECONDS } from '../../shared/outboxTuning'
import type { ActionRecoveryProvider } from '../actions/executor'
import type { Db } from '../db'
import { accountKeyedTables } from '../db/purgeAccount'
import { countSystemMailboxes, listMailboxThreads } from '../db/queries'
import { searchThreads } from '../db/search'
import { loadSeed, readSeedThread, readSeedThreadAccount } from '../dev/seed'
import { settleFollowUpCandidates } from '../followUps'
import { GmailApiError, GmailClient } from '../gmail/client'
import type { GmailThread } from '../gmail/parse'
import { GmailMailProvider } from '../gmail/provider'
import { reconcileRemoteDraft } from '../outbox/draftSync'
import { cachePrimarySendAs } from '../outbox/sendAs'
import { writeSetting } from '../settings'
import { reconcileThreadExistence } from '../sync/existenceSweep'
import { refreshMessageBodyFromStore, removeAccountFromIndex, searchMessageIndex } from '../sync/fts'
import { runFtsBackfill } from '../sync/ftsBackfill'
import { effectiveLifetimeThreadCap } from '../sync/lifetimeCap'
import { runLifetimeSweep } from '../sync/lifetimeSweep'
import { deleteThread, type LabelRow } from '../sync/persist'
import { runHistoryCycle } from '../sync/poller'
import type { HistoryRecord, MailProvider } from '../sync/provider'
import type { ServiceSession } from './session'

/**
 * What the seams need from the runtime. Deliberately tiny: the harness reads
 * the same database and the same active session production does, and every
 * renderer-visible effect goes back through the runtime's own broadcasts.
 */
export interface TestOperationsHost {
  readonly db: Db
  /** The seed fixture path, when the harness booted with one. */
  readonly testSeed: string | undefined
  readonly userDataPath: string
  activeAccountId(): string | null
  activeSession(): ServiceSession | null
  broadcastMailChanged(accountId: string | null): void
  /** Drop cached mailbox/split summaries a seam's direct write invalidated. */
  invalidateMailSummaries(accountId: string | null): void
}

/**
 * The hooks production request handlers consult. Absent outside the seam, so
 * a handler reads `context.test?.…` and gets production behavior by default.
 */
export interface TestHooks {
  waitForConversation(threadId: string): Promise<void>
  draftReopenDelayMs(): number
  draftInlineImageDelayMs(): number
  consumeDraftSaveFailure(): boolean
  searchWindowOverride(): number | null
}

export class TestOperations implements TestHooks {
  private draftSaveFailures = 0
  private conversationDelay: { threadId: string; delayMs: number } | null = null
  private draftReopenDelay = 0
  private draftInlineImageDelay = 0
  private setActiveAccountDelay = 0
  private searchWindow: number | null = null
  /** Test-only seeded providers, keyed by the owning account (A5 seam). */
  private readonly actionProviders = new Map<string, ActionRecoveryProvider>()
  /** Test-only send-capable providers (T35 seam): seeded sends can complete. */
  private readonly outboxProviders = new Map<string, MailProvider>()

  constructor(private readonly host: TestOperationsHost) {}

  async waitForConversation(threadId: string): Promise<void> {
    const delay = this.conversationDelay
    if (delay?.threadId === threadId) await new Promise((resolve) => setTimeout(resolve, delay.delayMs))
  }

  draftReopenDelayMs(): number {
    return this.draftReopenDelay
  }

  draftInlineImageDelayMs(): number {
    return this.draftInlineImageDelay
  }

  consumeDraftSaveFailure(): boolean {
    if (this.draftSaveFailures === 0) return false
    this.draftSaveFailures--
    return true
  }

  searchWindowOverride(): number | null {
    return this.searchWindow
  }

  /**
   * One-shot delay in front of an account switch, modeling the retirement
   * wait without needing a real mid-quiesce account.
   */
  async awaitSetActiveAccountDelay(): Promise<void> {
    if (this.setActiveAccountDelay <= 0) return
    const delayMs = this.setActiveAccountDelay
    this.setActiveAccountDelay = 0
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }

  actionProvider(accountId: string): ActionRecoveryProvider | null {
    return this.actionProviders.get(accountId) ?? null
  }

  outboxProvider(accountId: string): MailProvider | null {
    return this.outboxProviders.get(accountId) ?? null
  }

  /** A torn-down session drops its seeded providers with the rest of its state. */
  forgetAccount(accountId: string): void {
    this.actionProviders.delete(accountId)
    this.outboxProviders.delete(accountId)
  }

  async handle(channel: unknown, args: unknown[]): Promise<unknown> {
    if (typeof channel !== 'string') throw new Error('invalid test channel')
    const db = this.host.db
    const accountId = this.host.activeAccountId()
    if (channel === TEST_CHANNELS.setSyncState) {
      this.host.activeSession()?.syncController.setStateForTest(args[0] as SyncState)
      return undefined
    }
    if (channel === TEST_CHANNELS.reloadSeed) {
      if (!this.host.testSeed) throw new Error('seed store unavailable')
      const labels = args[0]
      if (labels !== undefined && !isLabelRows(labels)) throw new Error('invalid authoritative label catalog')
      const result = loadSeed(db, this.host.testSeed, labels === undefined ? {} : { labels })
      this.host.invalidateMailSummaries(null)
      if (result.labelsChanged) this.host.broadcastMailChanged(accountId)
      return undefined
    }
    if (channel === TEST_CHANNELS.deleteThread) {
      if (!accountId || typeof args[0] !== 'string') throw new Error('invalid thread delete')
      deleteThread(db, accountId, args[0])
      this.host.invalidateMailSummaries(accountId)
      return undefined
    }
    if (channel === TEST_CHANNELS.delayConversation) {
      const [threadId, delayMs] = args
      if (typeof threadId === 'string' && typeof delayMs === 'number' && delayMs >= 0) {
        this.conversationDelay = { threadId, delayMs }
      }
      return undefined
    }
    if (channel === TEST_CHANNELS.delayDraftReopen) {
      this.draftReopenDelay = validDelay(args[0])
      return undefined
    }
    if (channel === TEST_CHANNELS.delayDraftInlineImage) {
      this.draftInlineImageDelay = validDelay(args[0])
      return undefined
    }
    if (channel === TEST_CHANNELS.delaySetActiveAccount) {
      this.setActiveAccountDelay = validDelay(args[0])
      return undefined
    }
    if (channel === TEST_CHANNELS.updateMessageBody) {
      const [messageId, bodyText, bodyHtml] = args
      if (!accountId || typeof messageId !== 'string' || typeof bodyText !== 'string') {
        throw new Error('invalid message update')
      }
      if (bodyHtml !== undefined && typeof bodyHtml !== 'string') throw new Error('invalid message html')
      db.transaction(() => {
        db.prepare(
          'UPDATE messages SET body_text = ?, body_html = COALESCE(?, body_html) WHERE account_id = ? AND id = ?'
        ).run(bodyText, bodyHtml ?? null, accountId, messageId)
        // Keep the seam on the production invariant: body and index move together.
        refreshMessageBodyFromStore(db, accountId, messageId)
      })()
      this.host.broadcastMailChanged(accountId)
      return undefined
    }
    if (channel === TEST_CHANNELS.expireReminders) {
      // Back-date every pending reminder — snooze and follow-up alike — so a
      // relaunch finds it due, WITHOUT refreshing the live scheduler: the
      // specs that use this prove the deadline passing while the app is down,
      // and the production snooze bridge refreshes in the same call, which
      // would fire the reminder while the app is still up. The shift is
      // uniform, so an ordering between two reminders survives it.
      const expected = args[0]
      if (!accountId) throw new Error('no active account')
      if (typeof expected !== 'number' || !Number.isInteger(expected) || expected < 0) {
        throw new Error('invalid pending reminder count')
      }
      const pending = db
        .prepare(
          `SELECT COUNT(*) AS count, MAX(due_at) AS latest
             FROM reminders WHERE account_id = ? AND state = 'pending'`
        )
        .get(accountId) as { count: number; latest: number | null }
      // Poll-friendly: a spec waits for the reminder it is about to expire by
      // calling this until the count matches, and nothing is written before.
      if (pending.count !== expected || pending.latest === null) return pending.count
      const shift = pending.latest - (Date.now() - 1_000)
      if (shift > 0) {
        db.prepare(`UPDATE reminders SET due_at = due_at - ? WHERE account_id = ? AND state = 'pending'`).run(
          shift,
          accountId
        )
      }
      return pending.count
    }
    if (channel === TEST_CHANNELS.setSendAsSignature) {
      const signature = args[0]
      if (!accountId || typeof signature !== 'string') throw new Error('invalid send-as signature')
      cachePrimarySendAs(db, accountId, {
        sendAsEmail: accountId,
        signature,
        isPrimary: true,
        isDefault: true
      })
      return undefined
    }
    if (channel === TEST_CHANNELS.failNextDraftSave) {
      this.draftSaveFailures++
      return undefined
    }
    if (channel === TEST_CHANNELS.markDraftMirrored) {
      const [draftId, gmailDraftId] = args
      if (!accountId || typeof draftId !== 'string') throw new Error('invalid mirrored draft update')
      db.prepare(
        `UPDATE outbox SET mirror_revision = local_revision,
         gmail_draft_id = COALESCE(?, gmail_draft_id)
         WHERE account_id = ? AND id = ? AND state IN ('composing', 'drafted')`
      ).run(typeof gmailDraftId === 'string' ? gmailDraftId : null, accountId, draftId)
      return undefined
    }
    if (channel === TEST_CHANNELS.failNextAction || channel === TEST_CHANNELS.failNextActionAuth) {
      this.installActionFailure(
        args[0],
        channel === TEST_CHANNELS.failNextAction ? 'permanent' : 'auth-refresh'
      )
      return undefined
    }
    if (channel === TEST_CHANNELS.setUndoSendDelay) {
      const seconds = args[0]
      if (typeof seconds === 'number' && ALLOWED_UNDO_SEND_SECONDS.has(seconds)) {
        writeSetting(db, 'undoSendDelaySeconds', String(seconds))
      }
      return undefined
    }
    if (channel === TEST_CHANNELS.failOutbox) {
      const [id, message] = args
      if (!accountId || typeof id !== 'string' || typeof message !== 'string') {
        throw new Error('invalid outbox failure')
      }
      const result = db
        .prepare(
          `UPDATE outbox SET state = 'failed', send_at = NULL, last_error = ?
           WHERE account_id = ? AND id = ? AND state = 'queued'`
        )
        .run(message, accountId, id)
      if (result.changes === 0) throw new Error('queued message unavailable')
      return undefined
    }
    if (channel === TEST_CHANNELS.remoteDraft) {
      const remote = args[0]
      if (!accountId || !remote || typeof remote !== 'object') throw new Error('invalid remote draft')
      await reconcileRemoteDraft(db, accountId, remote as Parameters<typeof reconcileRemoteDraft>[2])
      this.host.broadcastMailChanged(accountId)
      return undefined
    }
    if (channel === TEST_CHANNELS.listMailboxThreadIds) {
      const mailbox = args[0]
      if (!accountId || !isMessageMailbox(mailbox)) throw new Error('mailbox query unavailable')
      const view = mailbox === 'all-mail' ? 'allMail' : mailbox
      return listMailboxThreads(db, accountId, view).map((row) => row.id)
    }
    if (channel === TEST_CHANNELS.accountDataStats) return this.accountDataStats(args[0])
    if (channel === TEST_CHANNELS.installSendProvider) {
      this.installTestSendProvider()
      return undefined
    }
    if (channel === TEST_CHANNELS.runHistoryCycle) return this.runTestHistoryCycle(args[0])
    if (channel === TEST_CHANNELS.runLifetimeSweep) return this.runTestLifetimeSweep(args[0])
    if (channel === TEST_CHANNELS.runExistenceSweep) return this.runTestExistenceSweep(args[0])
    if (channel === TEST_CHANNELS.runFtsBackfill) return this.runTestFtsBackfill(args[0])
    if (channel === TEST_CHANNELS.searchIndexStats) return this.testSearchIndexStats(args[0])
    if (channel === TEST_CHANNELS.queryPerfStats) return this.testQueryPerfStats(args[0])
    if (channel === TEST_CHANNELS.setSearchWindow) {
      // The partial marker only appears once a search fills its recency window,
      // which a seeded store is far too small to do at the production size.
      const limit = args[0]
      this.searchWindow = typeof limit === 'number' && limit > 0 ? Math.trunc(limit) : null
      return undefined
    }
    if (channel === TEST_CHANNELS.utilityState) return this.utilityState(args[0])
    throw new Error(`test operation is not implemented: ${channel}`)
  }

  /**
   * A6's zero-trace proof: per-table row counts across every account-keyed
   * table, the roster row, and the whole spool inventory (an orphaned spool
   * directory for *any* account fails the check).
   */
  private accountDataStats(requested: unknown): unknown {
    if (typeof requested !== 'string' || requested.length === 0) {
      throw new Error('invalid account stats request')
    }
    const db = this.host.db
    const perTable: Record<string, number> = {}
    let rowTotal = 0
    for (const table of accountKeyedTables(db)) {
      const count = (
        db.prepare(`SELECT COUNT(*) AS count FROM "${table}" WHERE account_id = ?`).get(requested) as {
          count: number
        }
      ).count
      perTable[table] = count
      rowTotal += count
    }
    const accountsRow = (
      db.prepare('SELECT COUNT(*) AS count FROM accounts WHERE id = ?').get(requested) as {
        count: number
      }
    ).count
    const spoolRoot = join(this.host.userDataPath, 'outbox')
    const spoolEntries = existsSync(spoolRoot) ? readdirSync(spoolRoot) : []
    return { rowTotal, perTable, ftsRows: perTable.message_fts ?? 0, accountsRow, spoolEntries }
  }

  private utilityState(value: unknown): unknown {
    const db = this.host.db
    const accountId = this.host.activeAccountId()
    if (!accountId || !Array.isArray(value) || !value.every((id) => typeof id === 'string')) {
      throw new Error('invalid utility state request')
    }
    const ids = value as string[]
    const placeholders = ids.map(() => '?').join(', ')
    const threadCount = ids.length
      ? (
          db
            .prepare(`SELECT COUNT(*) AS count FROM threads WHERE account_id = ? AND id IN (${placeholders})`)
            .get(accountId, ...ids) as { count: number }
        ).count
      : 0
    const messageCount = ids.length
      ? (
          db
            .prepare(
              `SELECT COUNT(*) AS count FROM messages WHERE account_id = ? AND thread_id IN (${placeholders})`
            )
            .get(accountId, ...ids) as { count: number }
        ).count
      : 0
    const cursors = db
      .prepare(
        `SELECT backfill_cursor, sweep_cursor, attachment_cursor, split_metadata_cursor, fts_cursor
         FROM sync_state WHERE account_id = ?`
      )
      .get(accountId)
    const memory = process.memoryUsage()
    const cacheSize = db.pragma('cache_size', { simple: true }) as number
    const pageSize = db.pragma('page_size', { simple: true }) as number
    const sqliteCacheBudgetKb = cacheSize < 0 ? -cacheSize : (cacheSize * pageSize) / 1024
    return {
      threadCount,
      messageCount,
      cursors,
      utilityMemoryKb: {
        rss: memory.rss / 1024,
        heapTotal: memory.heapTotal / 1024,
        heapUsed: memory.heapUsed / 1024,
        external: memory.external / 1024,
        sqliteCacheBudget: sqliteCacheBudgetKb
      }
    }
  }

  /**
   * T35 e2e seam: a send-capable in-memory provider for the active seeded
   * account, so the production OutboxSender can carry a queued row through
   * create/update/send and the post-send read — reminder creation and origin
   * resolution run the real code path, with zero Gmail.
   */
  private installTestSendProvider(): void {
    const seedPath = this.host.testSeed
    const accountId = this.host.activeAccountId()
    if (!seedPath || !accountId) return
    const drafts = new Map<string, { raw: string; threadId: string | null }>()
    const sentByThread = new Map<
      string,
      Array<{ id: string; internalDate: number; rfcMessageId: string | null }>
    >()
    let sequence = 0
    const rfcIdOf = (raw: string): string | null => /^Message-ID:\s*(<[^>]+>)\s*$/im.exec(raw)?.[1] ?? null
    const provider = {
      createDraft: async (input: { raw: string; threadId?: string | null }) => {
        sequence++
        const id = `test-draft-${sequence}`
        drafts.set(id, { raw: input.raw, threadId: input.threadId ?? null })
        return id
      },
      updateDraft: async (input: { id: string; raw?: string; threadId?: string | null }) => {
        const existing = drafts.get(input.id)
        if (!existing) throw new GmailApiError(404, 'test draft unavailable')
        drafts.set(input.id, {
          raw: input.raw ?? existing.raw,
          threadId: input.threadId ?? existing.threadId
        })
      },
      sendDraft: async (id: string) => {
        const draft = drafts.get(id)
        if (!draft) throw new GmailApiError(404, 'test draft unavailable')
        drafts.delete(id)
        sequence++
        const messageId = `test-sent-${sequence}`
        const threadId = draft.threadId ?? `t-test-sent-${sequence}`
        const sent = sentByThread.get(threadId) ?? []
        sent.push({ id: messageId, internalDate: Date.now(), rfcMessageId: rfcIdOf(draft.raw) })
        sentByThread.set(threadId, sent)
        return { id: messageId, threadId }
      },
      getThread: async (threadId: string): Promise<GmailThread> => {
        const base = readSeedThread(seedPath, threadId, Date.now(), accountId)
        const messages = [...(base?.messages ?? [])]
        for (const sent of sentByThread.get(threadId) ?? []) {
          messages.push({
            id: sent.id,
            threadId,
            labelIds: ['SENT'],
            internalDate: String(sent.internalDate),
            snippet: 'Sent from the e2e send seam.',
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'From', value: `Test <${accountId}>` },
                { name: 'Subject', value: 'e2e send' },
                ...(sent.rfcMessageId ? [{ name: 'Message-ID', value: sent.rfcMessageId }] : [])
              ]
            }
          })
        }
        if (messages.length === 0) throw new GmailApiError(404, 'test thread unavailable')
        return { id: threadId, messages }
      }
    } as unknown as MailProvider
    this.outboxProviders.set(accountId, provider)
  }

  /**
   * T35/GAP-1 e2e seam: run the production history cycle against supplied
   * records and thread snapshots — the reply-candidate settle, the snooze
   * wake, and the checkpoint advance all execute the shipped code.
   */
  private async runTestHistoryCycle(value: unknown): Promise<void> {
    const db = this.host.db
    const accountId = this.host.activeAccountId()
    const session = this.host.activeSession()
    if (!accountId || !session) throw new Error('no active account for history cycle')
    const request = (value ?? {}) as { records?: unknown; threads?: unknown }
    const records = Array.isArray(request.records) ? (request.records as HistoryRecord[]) : []
    const supplied = new Map(
      (Array.isArray(request.threads) ? (request.threads as GmailThread[]) : []).map(
        (thread) => [thread.id, thread] as const
      )
    )
    db.prepare(
      `INSERT INTO sync_state (account_id, last_history_id) VALUES (?, '1')
       ON CONFLICT(account_id) DO UPDATE SET last_history_id = '1'`
    ).run(accountId)
    const seedPath = this.host.testSeed
    const provider = {
      listHistory: async () => ({ history: records, historyId: '2' }),
      getThread: async (threadId: string): Promise<GmailThread> => {
        const thread =
          supplied.get(threadId) ??
          (seedPath ? readSeedThread(seedPath, threadId, Date.now(), accountId) : null)
        if (!thread) throw new GmailApiError(404, 'test thread unavailable')
        return thread
      }
    } as unknown as MailProvider
    await runHistoryCycle(db, accountId, provider, {
      wakeThread: (threadId) => session.snoozeScheduler.wakeThread(threadId),
      settleFollowUps: (candidates) => {
        if (
          settleFollowUpCandidates(
            db,
            accountId,
            candidates.map((candidate) => candidate.threadId)
          )
        ) {
          session.snoozeScheduler.refresh()
        }
      },
      hydrate: async () => {}
    })
    session.snoozeScheduler.refresh()
    this.host.broadcastMailChanged(accountId)
  }

  private installActionFailure(threadId: unknown, kind: 'permanent' | 'auth-refresh'): void {
    const seedPath = this.host.testSeed
    if (!seedPath || typeof threadId !== 'string') return
    // The failure arms the thread's *owning* account, active or not — a
    // background account's auth pause must be reproducible too (F18/A5).
    const owner = readSeedThreadAccount(seedPath, threadId)
    if (!owner || !readSeedThread(seedPath, threadId)) return
    const authProvider =
      kind === 'auth-refresh'
        ? new GmailMailProvider(
            new GmailClient(
              { client_id: 'attn-e2e', client_secret: 'attn-e2e' },
              {
                access_token: 'expired',
                refresh_token: 'revoked',
                expires_at: 0,
                email: owner
              },
              () => {},
              {
                fetch: async (input) => {
                  const url = String(input)
                  if (!url.includes('oauth2.googleapis.com/token')) {
                    throw new Error(`unexpected auth-failure request: ${url}`)
                  }
                  console.log(`[test] token refresh returned invalid_grant for ${owner}`)
                  return new Response('{"error":"invalid_grant"}', { status: 400 })
                }
              }
            )
          )
        : null
    let rejectTarget = true
    const mutate = async (requestedThreadId: string, add: string[], remove: string[]): Promise<void> => {
      if (requestedThreadId !== threadId) return
      if (!rejectTarget) {
        if (kind === 'auth-refresh') this.actionProviders.delete(owner)
        return
      }
      rejectTarget = false
      if (authProvider) return authProvider.modifyThread(requestedThreadId, add, remove)
      throw new GmailApiError(400, `gmail /threads/${threadId}/modify failed (400): permanent e2e failure`)
    }
    this.actionProviders.set(owner, {
      modifyThread: mutate,
      getThread: async (requestedThreadId) => {
        const requested = readSeedThread(seedPath, requestedThreadId)
        if (!requested) throw new GmailApiError(404, 'seed thread unavailable')
        if (requestedThreadId === threadId) this.actionProviders.delete(owner)
        return requested
      }
    })
  }

  private async runTestLifetimeSweep(value: unknown): Promise<unknown> {
    const db = this.host.db
    const accountId = this.host.activeAccountId()
    if (!accountId || !isLifetimeSweepRequest(value)) throw new Error('invalid lifetime sweep request')
    if (value.resetCursor) {
      db.prepare(
        `UPDATE sync_state
         SET sweep_cursor = ?, sweep_threads_done = 0
         WHERE account_id = ?`
      ).run(value.resetCursor, accountId)
    }
    const threads = new Map(value.threads.map((thread) => [thread.id, thread]))
    const formats: string[] = []
    const pageTokens: Array<string | undefined> = []
    let failure: unknown
    const provider = {
      getProfile: async () => ({
        emailAddress: accountId,
        historyId: 'test-history',
        threadsTotal: value.threadsTotal,
        messagesTotal: value.messagesTotal
      }),
      listThreadIds: async (options = {}) => {
        pageTokens.push(options.pageToken)
        if (value.pauseAtPageToken !== undefined && options.pageToken === value.pauseAtPageToken) {
          await new Promise<never>(() => {})
        }
        if (value.offlineAtPageToken !== undefined && options.pageToken === value.offlineAtPageToken) {
          throw new Error('offline')
        }
        return value.pages.find((candidate) => candidate.pageToken === options.pageToken) ?? { threadIds: [] }
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
      {
        requestIntervalMs: 0,
        pagePauseMs: 0,
        // With no explicit override the seam reads the persisted per-account
        // preference — the same value the production chain reads — so T32A's
        // e2e can drive the cap through the real settings bridge.
        threadCap: value.threadCap ?? effectiveLifetimeThreadCap(db, accountId)
      }
    )
    const state = db.prepare('SELECT sweep_cursor FROM sync_state WHERE account_id = ?').get(accountId) as
      | { sweep_cursor: string | null }
      | undefined
    return {
      cursor: state?.sweep_cursor ?? null,
      ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {}),
      formats,
      pageTokens
    }
  }

  private async runTestFtsBackfill(value: unknown): Promise<unknown> {
    const db = this.host.db
    const accountId = this.host.activeAccountId()
    if (!accountId || !isFtsBackfillRequest(value)) throw new Error('invalid FTS backfill request')
    if (value.resetIndex) {
      // Reproduce the manual revision-18 upgrade state: stored messages with an
      // empty index and an unset cursor.
      db.transaction(() => {
        removeAccountFromIndex(db, accountId)
        db.prepare('UPDATE sync_state SET fts_cursor = NULL WHERE account_id = ?').run(accountId)
      })()
    }
    let failure: unknown
    const result = await runFtsBackfill(
      db,
      accountId,
      {
        onProgress: () => {},
        onError: (error) => {
          failure = error
        }
      },
      {
        batchPauseMs: 0,
        ...(value.batchSize === undefined ? {} : { batchSize: value.batchSize }),
        ...(value.pauseAfterBatches === undefined
          ? {}
          : {
              onBatchCheckpoint: ({ batchIndex }) =>
                batchIndex + 1 >= (value.pauseAfterBatches as number)
                  ? new Promise<never>(() => {})
                  : undefined
            })
      }
    )
    const state = db.prepare('SELECT fts_cursor FROM sync_state WHERE account_id = ?').get(accountId) as
      | { fts_cursor: string | null }
      | undefined
    const parity = db
      .prepare(
        `SELECT
           (SELECT COUNT(*) FROM messages WHERE account_id = ?) AS messages,
           (SELECT COUNT(*) FROM message_fts_map WHERE account_id = ?) AS mapped,
           (SELECT COUNT(*) FROM message_fts) AS ftsRows`
      )
      .get(accountId, accountId)
    return {
      cursor: state?.fts_cursor ?? null,
      indexed: result?.messagesIndexed ?? null,
      parity,
      ...(failure ? { error: failure instanceof Error ? failure.message : String(failure) } : {})
    }
  }

  private testSearchIndexStats(value: unknown): unknown {
    const db = this.host.db
    const accountId = this.host.activeAccountId()
    if (!accountId || !isSearchIndexStatsRequest(value)) throw new Error('invalid search stats request')
    const runsPerQuery = value.runsPerQuery ?? 1
    const limit = value.limit ?? 50
    const queries = value.queries.map((match) => {
      const samplesUs: number[] = []
      let threadCount = 0
      for (let run = 0; run < runsPerQuery; run++) {
        const startedAt = process.hrtime.bigint()
        threadCount = searchMessageIndex(db, accountId, match, limit).length
        samplesUs.push(Number(process.hrtime.bigint() - startedAt) / 1_000)
      }
      return { match, threadCount, samplesUs }
    })
    const indexBytes = (
      db
        .prepare("SELECT COALESCE(SUM(pgsize), 0) AS bytes FROM dbstat WHERE name LIKE '%message_fts%'")
        .get() as { bytes: number }
    ).bytes
    return { indexBytes, queries }
  }

  private testQueryPerfStats(value: unknown): unknown {
    const db = this.host.db
    const accountId = this.host.activeAccountId()
    if (!accountId || !isQueryPerfStatsRequest(value)) throw new Error('invalid query perf request')
    const runsPerQuery = value.runsPerQuery ?? 1
    const threadLimit = value.threadLimit ?? THREAD_PAGE_SIZE + 1
    const searchQuery = value.searchQuery ?? 'performance'

    const time = <T>(read: () => T): { result: T; samplesUs: number[] } => {
      const samplesUs: number[] = []
      let result!: T
      for (let run = 0; run < runsPerQuery; run++) {
        const startedAt = process.hrtime.bigint()
        result = read()
        samplesUs.push(Number(process.hrtime.bigint() - startedAt) / 1_000)
      }
      return { result, samplesUs }
    }

    const mailboxCounts = time(() => countSystemMailboxes(db, accountId))
    const allMailPage = time(() => listMailboxThreads(db, accountId, 'allMail', threadLimit))
    const search = time(() => searchThreads(db, accountId, searchQuery))

    return {
      mailboxCounts: { samplesUs: mailboxCounts.samplesUs, counts: mailboxCounts.result },
      allMailPage: { samplesUs: allMailPage.samplesUs, rowCount: allMailPage.result.length },
      search: {
        samplesUs: search.samplesUs,
        rowCount: search.result.rows.length,
        partial: search.result.partial
      }
    }
  }

  private async runTestExistenceSweep(value: unknown): Promise<unknown> {
    const db = this.host.db
    const accountId = this.host.activeAccountId()
    if (!accountId || !isExistenceSweepRequest(value)) throw new Error('invalid existence sweep request')
    const provider: Pick<MailProvider, 'listThreadIds' | 'getThread'> = {
      listThreadIds: async (options = {}) => {
        if (options.labelIds?.includes('SPAM')) return { threadIds: value.spamThreadIds }
        if (options.labelIds?.includes('TRASH')) return { threadIds: value.trashThreadIds }
        return { threadIds: value.allMailThreadIds }
      },
      getThread: async () => {
        // This seam receives complete authoritative id sets. A local row
        // absent from their union models a server-purged thread.
        throw new GmailApiError(404, 'test existence sweep thread missing')
      }
    }
    const result = await reconcileThreadExistence(db, accountId, provider)
    if (result?.deletedThreadIds.length) this.host.broadcastMailChanged(accountId)
    return result
  }
}

interface LifetimeSweepRequest {
  resetCursor?: string
  threadCap?: number
  threads: GmailThread[]
  pages: Array<{
    pageToken?: string
    threadIds: string[]
    nextPageToken?: string
    resultSizeEstimate?: number
  }>
  offlineAtPageToken?: string
  pauseAtPageToken?: string
  threadsTotal?: number
  messagesTotal?: number
}

interface ExistenceSweepRequest {
  allMailThreadIds: string[]
  spamThreadIds: string[]
  trashThreadIds: string[]
}

interface FtsBackfillRequest {
  resetIndex?: boolean
  batchSize?: number
  pauseAfterBatches?: number
}

interface SearchIndexStatsRequest {
  queries: string[]
  runsPerQuery?: number
  limit?: number
}

interface QueryPerfStatsRequest {
  runsPerQuery?: number
  threadLimit?: number
  searchQuery?: string
}

function optionalPositiveInteger(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isInteger(value) && value > 0)
}

function isFtsBackfillRequest(value: unknown): value is FtsBackfillRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<FtsBackfillRequest>
  return (
    (request.resetIndex === undefined || typeof request.resetIndex === 'boolean') &&
    optionalPositiveInteger(request.batchSize) &&
    optionalPositiveInteger(request.pauseAfterBatches)
  )
}

function isSearchIndexStatsRequest(value: unknown): value is SearchIndexStatsRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<SearchIndexStatsRequest>
  return (
    Array.isArray(request.queries) &&
    request.queries.length > 0 &&
    request.queries.every((query) => typeof query === 'string' && query.length > 0) &&
    optionalPositiveInteger(request.runsPerQuery) &&
    optionalPositiveInteger(request.limit)
  )
}

function isQueryPerfStatsRequest(value: unknown): value is QueryPerfStatsRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<QueryPerfStatsRequest>
  return (
    optionalPositiveInteger(request.runsPerQuery) &&
    optionalPositiveInteger(request.threadLimit) &&
    (request.searchQuery === undefined || typeof request.searchQuery === 'string')
  )
}

function isMessageMailbox(value: unknown): value is MessageMailbox {
  return value === 'all-mail' || value === 'spam' || value === 'trash'
}

function validDelay(value: unknown): number {
  return typeof value === 'number' && value >= 0 ? value : 0
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

function isLifetimeSweepRequest(value: unknown): value is LifetimeSweepRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<LifetimeSweepRequest>
  return (
    Array.isArray(request.threads) &&
    Array.isArray(request.pages) &&
    (request.threadCap === undefined || (Number.isSafeInteger(request.threadCap) && request.threadCap >= 0))
  )
}

function isExistenceSweepRequest(value: unknown): value is ExistenceSweepRequest {
  if (!value || typeof value !== 'object') return false
  const request = value as Partial<ExistenceSweepRequest>
  return [request.allMailThreadIds, request.spamThreadIds, request.trashThreadIds].every(
    (ids) => Array.isArray(ids) && ids.every((id) => typeof id === 'string')
  )
}
