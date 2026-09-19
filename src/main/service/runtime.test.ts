import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyDraftInput } from '../../shared/drafts'
import { IPC_CHANNELS, TEST_CHANNELS } from '../../shared/ipc'
import type { ThreadPage } from '../../shared/mail'
import { OTHER_SPLIT_ID, type SplitState } from '../../shared/splits'
import { storeActionError } from '../actions/execute'
import { type Db, openDatabase } from '../db'
import { runMailboxMembershipBackfill } from '../db/mailboxMembership'
import * as queries from '../db/queries'
import { readSeedThread } from '../dev/seed'
import type { GmailClient } from '../gmail/client'
import type { GmailThread } from '../gmail/parse'
import { GmailMailProvider } from '../gmail/provider'
import { saveDraft } from '../outbox/drafts'
import * as spool from '../outbox/spool'
import * as splits from '../splits'
import { persistThread } from '../sync/persist'
import { type HistoryPoller, historyEvents } from '../sync/poller'
import type { ServerSearchProvider } from '../sync/serverSearch'
import { SPLIT_TRIAGE_NOTIFY_WAIT_MS } from '../sync/tuning'
import type { SyncController } from '../syncController'
import { type SchedulerTime, systemTime } from '../time'
import {
  SERVICE_PROTOCOL_VERSION,
  type ServiceAccountsState,
  type ServiceEvent,
  type ServiceInitialize
} from './protocol'
import { IndexingSlot, ServiceRuntime } from './runtime'

// Two seeded accounts prove the session-per-account runtime (F18): reads are
// answered for the active account only, the switch is durable, and the badge
// spans the roster. Seeded sessions never touch Gmail, so this runs hermetic.

const TWO_ACCOUNTS = {
  accounts: [
    {
      account: 'primary@attn.test',
      labels: [{ id: 'Label_A', name: 'receipts', type: 'user' }],
      threads: [
        {
          id: 't-alpha',
          messages: [
            {
              id: 'm-alpha',
              labelIds: ['INBOX', 'UNREAD'],
              receivedDaysAgo: 0,
              from: 'Ada <ada@example.com>',
              to: 'primary@attn.test',
              subject: 'Alpha roadmap',
              snippet: 'Alpha snippet',
              bodyText: 'Alpha body'
            }
          ]
        }
      ]
    },
    {
      account: 'second@attn.test',
      labels: [{ id: 'Label_B', name: 'launches', type: 'user' }],
      threads: [
        {
          id: 't-beta',
          messages: [
            {
              id: 'm-beta',
              labelIds: ['INBOX', 'UNREAD', 'IMPORTANT'],
              receivedDaysAgo: 0,
              from: 'Bea <bea@example.com>',
              to: 'second@attn.test',
              subject: 'Beta launch',
              snippet: 'Beta snippet',
              bodyText: 'Beta body'
            }
          ]
        },
        {
          id: 't-beta-2',
          messages: [
            {
              id: 'm-beta-2',
              labelIds: ['INBOX', 'UNREAD'],
              receivedDaysAgo: 1,
              from: 'Bea <bea@example.com>',
              to: 'second@attn.test',
              subject: 'Beta digest',
              snippet: 'Digest snippet',
              bodyText: 'Digest body'
            }
          ]
        }
      ]
    }
  ]
}

/**
 * A runtime clock whose timers only fire when a test says so. The smart-splits
 * notification wait rides it, so no case here waits out a deadline on the wall
 * clock.
 */
class ManualRuntimeTimers {
  private next = 1
  private pending = new Map<number, { callback: () => void; delayMs: number }>()

  readonly time: SchedulerTime = {
    now: () => Date.now(),
    timers: {
      setTimeout: (callback, delayMs) => {
        const id = this.next++
        this.pending.set(id, { callback, delayMs })
        return id as unknown as ReturnType<typeof setTimeout>
      },
      clearTimeout: (handle) => {
        this.pending.delete(handle as unknown as number)
      }
    }
  }

  fire(maxDelayMs: number): void {
    for (const [id, entry] of [...this.pending]) {
      if (entry.delayMs <= maxDelayMs) {
        this.pending.delete(id)
        entry.callback()
      }
    }
  }
}

/** Settle queued promise work without letting any timer callback run. */
async function flushPromises(): Promise<void> {
  for (let turn = 0; turn < 20; turn++) await Promise.resolve()
}

/** Let queued promise work and a few macrotask turns settle. */
async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 5; turn++) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
}

describe('ServiceRuntime with several accounts', () => {
  let dir: string | null = null
  let runtimes: ServiceRuntime[] = []

  afterEach(async () => {
    for (const runtime of runtimes) await runtime.stop()
    runtimes = []
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  function makeInput(): ServiceInitialize {
    dir ??= mkdtempSync(join(tmpdir(), 'attn-runtime-test-'))
    const seedPath = join(dir, 'seed.json')
    writeFileSync(seedPath, JSON.stringify(TWO_ACCOUNTS))
    return {
      protocolVersion: SERVICE_PROTOCOL_VERSION,
      dbPath: join(dir, 'attn.db'),
      userDataPath: dir,
      downloadsPath: dir,
      testMode: true,
      testSeed: seedPath,
      accounts: { config: null, accounts: [], activeAccountId: null },
      focused: false,
      triageKey: null
    }
  }

  async function createRuntime(
    input: ServiceInitialize,
    time: SchedulerTime = systemTime
  ): Promise<{ runtime: ServiceRuntime; events: ServiceEvent[] }> {
    const events: ServiceEvent[] = []
    const runtime = await ServiceRuntime.create(input, (event) => events.push(event), time)
    runtimes.push(runtime)
    return { runtime, events }
  }

  it('validates snooze deadlines against the injected reminder clock', async () => {
    let now = Date.now() + 86400000
    const { runtime } = await createRuntime(makeInput(), { ...systemTime, now: () => now })
    await expect(
      runtime.invoke(IPC_CHANNELS.mailSnooze, [{ threadIds: ['t-alpha'], dueAt: now - 1 }])
    ).rejects.toThrow('Choose a future snooze time')
    await runtime.invoke(IPC_CHANNELS.mailSnooze, [{ threadIds: ['t-alpha'], dueAt: now + 1000 }])
    now += 2000
    await expect(
      runtime.invoke(IPC_CHANNELS.mailSnooze, [{ threadIds: ['t-alpha'], dueAt: now - 1 }])
    ).rejects.toThrow('Choose a future snooze time')
  })

  /**
   * Apply a roster without awaiting the deferred session creates, the way
   * `apply-accounts` does before it awaits them: several cases below assert
   * what the runtime reports *before* a re-added account's session exists.
   */
  function pushAccounts(runtime: ServiceRuntime, accounts: ServiceAccountsState): void {
    void (
      runtime as unknown as { applyAccounts(state: ServiceAccountsState): Promise<void>[] }
    ).applyAccounts(accounts)
  }

  async function listInboxSubjects(runtime: ServiceRuntime): Promise<string[]> {
    const page = (await runtime.invoke(IPC_CHANNELS.mailListThreads, [{ view: 'inbox' }])) as ThreadPage
    return page.rows.map((row) => row.subject ?? '')
  }

  function cloneSeedThread(seedPath: string, threadId: string): GmailThread {
    const thread = readSeedThread(seedPath, threadId)
    if (!thread) throw new Error(`Seeded thread ${threadId} missing`)
    return JSON.parse(JSON.stringify(thread)) as GmailThread
  }

  async function prepareAttachmentRemoval() {
    const input = makeInput()
    const { runtime } = await createRuntime(input)
    const { db } = runtime as unknown as { db: Db }
    const source = join(input.userDataPath, 'private.txt')
    writeFileSync(source, 'private attachment')
    const drafts = []
    for (const accountId of ['primary@attn.test', 'second@attn.test']) {
      const id = saveDraft(db, accountId, emptyDraftInput(), 10)
      await spool.spoolDraftAttachments(db, input.userDataPath, accountId, id, [source])
      drafts.push({ id, directory: join(input.userDataPath, 'outbox', id) })
    }
    await runtime.internal('apply-accounts', [
      { config: null, accounts: [], activeAccountId: null, seedAccountIds: ['primary@attn.test'] }
    ])
    return { runtime, db, drafts }
  }

  it('holds the relayed smart-splits key in memory and never in SQLite', async () => {
    const seeded = { ...makeInput(), triageKey: 'ts-seeded-key' }
    const { runtime } = await createRuntime(seeded)
    expect(runtime.triageKey()).toBe('ts-seeded-key')

    await runtime.internal('apply-triage-key', ['ts-updated-key'])
    expect(runtime.triageKey()).toBe('ts-updated-key')

    // Removing the key relays null; nothing about it is ever persisted.
    await runtime.internal('apply-triage-key', [null])
    expect(runtime.triageKey()).toBeNull()
    await expect(runtime.internal('apply-triage-key', [''])).rejects.toThrow('invalid smart splits key')
    await expect(runtime.internal('apply-triage-key', [7])).rejects.toThrow('invalid smart splits key')

    const db = openDatabase(seeded.dbPath)
    const rows = db.prepare("SELECT value FROM settings WHERE value LIKE 'ts-%'").all()
    expect(rows).toEqual([])
    db.close()
  })

  it('returns the active account mailbox totals and reuses them between writes', async () => {
    const { runtime } = await createRuntime(makeInput())
    const count = vi.spyOn(queries, 'countSystemMailboxes')
    const read = () => runtime.invoke(IPC_CHANNELS.mailGetMailboxCounts, [])
    const first = await read()
    expect(first).toMatchObject({ inbox: 1, allMail: 1 })
    expect(await read()).toBe(first)
    expect(count).toHaveBeenCalledTimes(1)

    await runtime.internal('set-active-account', ['second@attn.test'])
    expect(await read()).toMatchObject({ inbox: 2, allMail: 2 })
    await runtime.internal('set-active-account', ['primary@attn.test'])
    expect(await read()).toBe(first)
    expect(count).toHaveBeenCalledTimes(2)

    await runtime.invoke(IPC_CHANNELS.mailTriage, [{ kind: 'archive', threadIds: ['t-alpha'] }])
    expect(await read()).toMatchObject({ inbox: 0, allMail: 1 })
    await runtime.internal('set-active-account', ['second@attn.test'])
    expect(await read()).toMatchObject({ inbox: 2, allMail: 2 })
    expect(count).toHaveBeenCalledTimes(4)
  })

  it('refreshes mailbox totals after silent writes and reuses them between writes', async () => {
    const input = makeInput()
    const { runtime } = await createRuntime(input)
    const count = vi.spyOn(queries, 'countSystemMailboxes')
    const read = () => runtime.invoke(IPC_CHANNELS.mailGetMailboxCounts, [])
    const internals = runtime as unknown as { db: Db }

    const first = await read()
    expect(first).toMatchObject({ inbox: 1, allMail: 1 })
    expect(await read()).toBe(first)
    expect(count).toHaveBeenCalledTimes(1)

    const added = cloneSeedThread(input.testSeed ?? '', 't-alpha')
    added.id = 't-alpha-silent'
    const addedMessage = added.messages?.[0]
    if (!addedMessage) throw new Error('Seeded message missing')
    addedMessage.id = 'm-alpha-silent'
    addedMessage.threadId = added.id
    internals.db.transaction(() => {
      persistThread(internals.db, 'primary@attn.test', added)
    })()

    // Preserving summaries across account-selection writes must not make a
    // summary from before this unannounced mail change look current again.
    await runtime.internal('set-active-account', ['second@attn.test'])
    await runtime.internal('set-active-account', ['primary@attn.test'])

    const second = await read()
    expect(second).toMatchObject({ inbox: 2, allMail: 2 })
    expect(await read()).toBe(second)
    expect(count).toHaveBeenCalledTimes(2)
  })

  it('refreshes mailbox totals between committed membership backfill batches', async () => {
    const input = makeInput()
    const { runtime } = await createRuntime(input)
    const count = vi.spyOn(queries, 'countSystemMailboxes')
    const read = () => runtime.invoke(IPC_CHANNELS.mailGetMailboxCounts, [])
    const internals = runtime as unknown as { db: Db }

    internals.db.prepare('DELETE FROM thread_mailboxes WHERE account_id = ?').run('primary@attn.test')

    const empty = await read()
    expect(empty).toMatchObject({ inbox: 0, allMail: 0 })
    expect(await read()).toBe(empty)
    expect(count).toHaveBeenCalledTimes(1)

    let batches = 0
    await runMailboxMembershipBackfill(internals.db, 'primary@attn.test', {
      batchSize: 1,
      batchPauseMs: 0,
      shouldContinue: () => batches++ === 0
    })

    const partial = await read()
    expect(partial).toMatchObject({ inbox: 1, allMail: 1 })
    expect(await read()).toBe(partial)
    expect(count).toHaveBeenCalledTimes(2)
  })

  it('keeps mailbox totals fresh when a partial Gmail search finishes on another account', async () => {
    const input = makeInput()
    const { runtime } = await createRuntime(input)
    const read = () => runtime.invoke(IPC_CHANNELS.mailGetMailboxCounts, [])
    expect(await read()).toMatchObject({ inbox: 1, allMail: 1 })
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let reachedSecond!: () => void
    const secondRequested = new Promise<void>((resolve) => {
      reachedSecond = resolve
    })
    const provider: ServerSearchProvider = {
      listThreadIds: async () => ({ threadIds: ['t-new', 't-held'] }),
      getThread: async (id) => {
        if (id === 't-held') {
          reachedSecond()
          await held
          throw new Error('provider failed after a partial result')
        }
        const thread = readSeedThread(input.testSeed ?? '', 't-alpha')
        const message = thread?.messages?.[0]
        if (!thread || !message) throw new Error('Seeded thread missing')
        thread.id = 't-new'
        message.id = 'm-new'
        message.threadId = 't-new'
        return thread
      },
      getAttachmentData: async () => undefined
    }
    const internals = runtime as unknown as { makeCurrentServerSearchProvider: () => ServerSearchProvider }
    vi.spyOn(internals, 'makeCurrentServerSearchProvider').mockReturnValue(provider)
    const search = runtime.invoke(IPC_CHANNELS.mailSearchAll, ['partial-counts', 'Alpha'])
    try {
      await secondRequested
      const count = vi.spyOn(queries, 'countSystemMailboxes')
      expect(await read()).toMatchObject({ inbox: 2, allMail: 2 })
      expect(await read()).toMatchObject({ inbox: 2, allMail: 2 })
      expect(count).toHaveBeenCalledTimes(2)
      await runtime.internal('set-active-account', ['second@attn.test'])
      release()
      await expect(search).resolves.toMatchObject({ status: 'error' })
      await runtime.internal('set-active-account', ['primary@attn.test'])
      expect(await read()).toMatchObject({ inbox: 2, allMail: 2 })
      expect(count).toHaveBeenCalledTimes(3)
    } finally {
      release()
      await search
    }
  })

  it('refreshes split counts after notification and mail changes', async () => {
    const input = makeInput()
    writeFileSync(
      input.testSeed ?? '',
      JSON.stringify({ accounts: TWO_ACCOUNTS.accounts.map((account) => ({ ...account, splitSetup: true })) })
    )
    const { runtime } = await createRuntime(input)
    const count = vi.spyOn(splits, 'getSplitState')
    const read = async () => (await runtime.invoke(IPC_CHANNELS.splitsGetState, [])) as SplitState
    const statuses = () => runtime.invoke(IPC_CHANNELS.accountsGetStatuses, [])
    expect((await read()).splits.find((split) => split.id === OTHER_SPLIT_ID)?.unread).toBe(1)
    await runtime.internal('set-active-account', ['second@attn.test'])
    await read()
    await statuses()
    await runtime.internal('set-active-account', ['primary@attn.test'])
    await read()
    expect(count).not.toHaveBeenCalled()

    await runtime.invoke(IPC_CHANNELS.splitsSetNotify, [OTHER_SPLIT_ID, true])
    expect(await statuses()).toEqual([
      expect.objectContaining({ accountId: 'primary@attn.test', unread: 1 }),
      expect.objectContaining({ accountId: 'second@attn.test', unread: 1 })
    ])
    expect((await read()).splits.find((split) => split.id === OTHER_SPLIT_ID)?.notify).toBe(true)

    await runtime.invoke(IPC_CHANNELS.mailTriage, [{ kind: 'archive', threadIds: ['t-alpha'] }])
    expect((await read()).splits.find((split) => split.id === OTHER_SPLIT_ID)).toMatchObject({
      total: 0,
      unread: 0
    })
    expect(await statuses()).toEqual([
      expect.objectContaining({ accountId: 'primary@attn.test', unread: 0 }),
      expect.objectContaining({ accountId: 'second@attn.test', unread: 1 })
    ])
    expect(count).toHaveBeenCalled()
  })

  it.each(['Keep', 'Delete'])(
    'discards a late history response after removing an account with %s',
    async (choice) => {
      const input = makeInput()
      const { runtime } = await createRuntime(input)
      const accountId = 'primary@attn.test'
      // Keep seeded scheduling, but use the runtime's real client/provider with
      // a held transport response. This exercises the session cancellation scope.
      await runtime.internal('apply-accounts', [
        {
          config: { client_id: 'test-client', client_secret: 'test-secret' },
          accounts: [
            {
              id: accountId,
              generation: 1,
              tokens: { access_token: 'test-access', expires_at: Date.now() + 3_600_000 }
            }
          ],
          activeAccountId: accountId
        }
      ])
      const internals = runtime as unknown as {
        db: Db
        sessions: Map<string, { syncController: SyncController }>
        makeClientFor(id: string): GmailClient
      }
      const controller = internals.sessions.get(accountId)?.syncController
      if (!controller) throw new Error('Seeded account session missing')
      const polling = controller as unknown as {
        startHistoryPoller(id: string, provider: GmailMailProvider, generation: number): void
        generation: number
        poller: HistoryPoller
      }
      let releaseThread!: (response: Response) => void
      let readSignal: AbortSignal | null | undefined
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string | URL, init?: RequestInit) => {
          const url = String(input)
          if (url.includes('/history?'))
            return new Response(
              JSON.stringify({
                historyId: '2',
                history: [{ id: '2', messages: [{ id: 'm-late', threadId: 't-late' }] }]
              })
            )
          if (url.includes('/threads/t-late?')) {
            readSignal = init?.signal
            return new Promise<Response>((resolve) => {
              releaseThread = resolve
            })
          }
          throw new Error(`Unexpected Gmail read: ${url}`)
        })
      )
      internals.db
        .prepare('UPDATE sync_state SET last_history_id = ? WHERE account_id = ?')
        .run('1', accountId)
      polling.startHistoryPoller(
        accountId,
        new GmailMailProvider(internals.makeClientFor(accountId)),
        polling.generation
      )
      const cycle = polling.poller.runNow()
      await vi.waitFor(() => expect(releaseThread).toBeTypeOf('function'))
      await runtime.internal('apply-accounts', [
        {
          config: null,
          accounts: [],
          seedAccountIds: ['second@attn.test'],
          activeAccountId: 'second@attn.test'
        }
      ])
      expect(readSignal?.aborted).toBe(true)
      if (choice === 'Delete') await runtime.internal('remove-account-data', [accountId])

      const lateThread = readSeedThread(input.testSeed ?? '', 't-alpha')
      const message = lateThread?.messages?.[0]
      if (!lateThread || !message) throw new Error('Seeded thread missing')
      lateThread.id = 't-late'
      message.id = 'm-late'
      message.threadId = 't-late'
      // Even a buffered response that ignores AbortSignal cannot reach SQLite.
      releaseThread(new Response(JSON.stringify(lateThread)))
      await cycle
      const rows = internals.db
        .prepare('SELECT id FROM messages WHERE account_id = ? ORDER BY id')
        .all(accountId)
      expect(rows).toEqual(choice === 'Delete' ? [] : [{ id: 'm-alpha' }])
      expect(await listInboxSubjects(runtime)).toEqual(['Beta launch', 'Beta digest'])
    }
  )

  it('keeps persisting refreshed tokens after a roster push replaces the auth object', async () => {
    const { runtime, events } = await createRuntime(makeInput())
    const accountId = 'primary@attn.test'
    // Main rebuilds this payload for every push, so each one carries a new
    // auth object even when nothing about the credentials changed.
    const roster = () => ({
      config: { client_id: 'test-client', client_secret: 'test-secret' },
      accounts: [
        {
          id: accountId,
          generation: 1,
          tokens: { access_token: 'stale-access', refresh_token: 'refresh-token', expires_at: 0 }
        }
      ],
      activeAccountId: accountId
    })
    await runtime.internal('apply-accounts', [roster()])
    const internals = runtime as unknown as { makeClientFor(id: string): GmailClient }
    // The poller holds one client for the life of its session.
    const client = internals.makeClientFor(accountId)

    // A roster push that reauthenticates nothing still assigns a fresh auth
    // object; persistence used to compare object identity and stop here (B31).
    await runtime.internal('apply-accounts', [roster()])

    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const url = String(input)
        if (url.startsWith('https://oauth2.googleapis.com/token')) {
          return new Response(JSON.stringify({ access_token: 'fresh-access', expires_in: 3600 }))
        }
        if (url.includes('/profile')) return new Response(JSON.stringify({ emailAddress: accountId }))
        throw new Error(`Unexpected Gmail request: ${url}`)
      })
    )
    await client.get('/profile')

    expect(events.filter((event) => event.kind === 'token-update').at(-1)).toMatchObject({
      accountId,
      generation: 1,
      tokens: { access_token: 'fresh-access', refresh_token: 'refresh-token' }
    })
  })

  it('serves the active account only, switches durably, and sums the badge', async () => {
    const input = makeInput()
    const { runtime, events } = await createRuntime(input)

    expect(runtime.ready().accountIds).toEqual(['primary@attn.test', 'second@attn.test'])
    expect(runtime.ready().activeAccountId).toBe('primary@attn.test')
    expect(await listInboxSubjects(runtime)).toEqual(['Alpha roadmap'])

    // The badge covers every account, not the active one (F12/F18).
    const badge = events.filter((event) => event.kind === 'badge').at(-1)
    expect(badge && badge.kind === 'badge' ? badge.unreadCount : null).toBe(3)

    await runtime.internal('set-active-account', ['second@attn.test'])
    expect(runtime.ready().activeAccountId).toBe('second@attn.test')
    expect(await listInboxSubjects(runtime)).toEqual(['Beta launch', 'Beta digest'])
    const syncState = events.filter((event) => event.kind === 'sync-state').at(-1)
    expect(syncState && syncState.kind === 'sync-state' ? syncState.payload.phase : null).toBe('idle')

    await expect(runtime.internal('set-active-account', ['nobody@attn.test'])).rejects.toThrow(
      'unknown account'
    )

    // The switch persists: a relaunch against the same store resumes on the
    // switched-to account, not the roster head.
    await runtime.stop()
    const second = await createRuntime(makeInput())
    expect(second.runtime.ready().activeAccountId).toBe('second@attn.test')
    expect(await listInboxSubjects(second.runtime)).toEqual(['Beta launch', 'Beta digest'])
  })

  /**
   * A runtime with smart splits switched on, the classifier pointed at the
   * scripted TypeSafe service, and every starter split silenced except the
   * ones the caller names. `notifyOther` decides whether an unjudged arrival
   * would notify on its own, which is what separates "waited for the judgment"
   * from "notified anyway".
   */
  async function armTriage(
    runtime: ServiceRuntime,
    options: { probability: number; notifyOther?: boolean }
  ): Promise<void> {
    const state = (await runtime.invoke(IPC_CHANNELS.splitsGetState, [])) as SplitState
    for (const split of state.splits) {
      if (split.notify) await runtime.invoke(IPC_CHANNELS.splitsSetNotify, [split.id, false])
    }
    await runtime.invoke(IPC_CHANNELS.splitsSave, [
      {
        name: 'Roadmaps',
        mode: 'description',
        description: 'Anything about a product roadmap',
        notify: true
      }
    ])
    if (options.notifyOther) await runtime.invoke(IPC_CHANNELS.splitsSetNotify, [OTHER_SPLIT_ID, true])
    await runtime.invoke(IPC_CHANNELS.aiSetSetting, ['triageEnabled', true])
    await runtime.internal('apply-triage-key', ['ts-secret'])
    // Drain the queue against a "no" script first, so the stored mail is fully
    // judged and the arrival below is the only work left. Then arm the answer
    // the arriving reply gets.
    await runtime.internal('test', [TEST_CHANNELS.installFakeTriageProvider, { default: 0 }])
    await runtime.internal('test', [TEST_CHANNELS.runTriagePass])
    await runtime.internal('test', [
      TEST_CHANNELS.installFakeTriageProvider,
      { bySubject: [{ subjectIncludes: 'Alpha', probabilities: { Roadmaps: options.probability } }] }
    ])
  }

  /** A reply landing on the seeded thread: new evidence, so a fresh judgment. */
  function appendReply(dbPath: string, messageId = 'm-alpha-2'): void {
    const db = openDatabase(dbPath)
    // The seed stamps the original message at 09:00 today, so a reply stamped
    // with the clock alone is older than its thread before that hour and is
    // not new evidence. Stamp it after whatever the thread already holds.
    const latest = db
      .prepare(
        "SELECT MAX(internal_date) AS at FROM messages WHERE account_id = 'primary@attn.test' AND thread_id = 't-alpha'"
      )
      .get() as { at: number | null }
    db.prepare(
      `INSERT INTO messages (account_id, id, thread_id, from_name, from_email, snippet, internal_date,
                             body_text, recipients_json, attachments_json, labels_json)
       VALUES ('primary@attn.test', ?, 't-alpha', 'Ada', 'ada@example.com', 'Reply snippet', ?,
               'More on the roadmap', '{"to":[],"cc":[],"bcc":[],"replyTo":[]}', '[]', '["INBOX","UNREAD"]')`
    ).run(messageId, Math.max(Date.now(), (latest.at ?? 0) + 1_000))
    db.close()
  }

  /**
   * Every notification decision, in order. Both replies share one subject, so
   * the message id is what says which arrival a decision was about.
   */
  function notificationEvents(events: ServiceEvent[]): { subjects: string[]; messageIds: string[] }[] {
    return events.flatMap((event) =>
      event.kind === 'notification-candidates'
        ? [
            {
              subjects: event.candidates.map((candidate) => candidate.subject),
              messageIds: event.candidates.map((candidate) => candidate.messageId)
            }
          ]
        : []
    )
  }

  const ARRIVAL = [{ threadId: 't-alpha', messageId: 'm-alpha-2' }]

  it('waits for an arriving conversation to be judged before it decides to notify', async () => {
    const input = makeInput()
    const { runtime, events } = await createRuntime(input)
    await armTriage(runtime, { probability: 0.95 })
    appendReply(input.dbPath)

    historyEvents.emit('newMail', 'primary@attn.test', ARRIVAL)
    await runtime.internal('test', [TEST_CHANNELS.runTriagePass])
    await flushMicrotasks()

    // Nothing else notifies for this thread: the candidate exists only because
    // the judgment landed first and moved it into the described split.
    expect(notificationEvents(events)).toEqual([{ subjects: ['Alpha roadmap'], messageIds: ['m-alpha-2'] }])
  })

  it('notifies once a judgment lands after the wait has already expired', async () => {
    const manual = new ManualRuntimeTimers()
    const input = makeInput()
    const { runtime, events } = await createRuntime(input, manual.time)
    await armTriage(runtime, { probability: 0.95 })
    appendReply(input.dbPath)

    historyEvents.emit('newMail', 'primary@attn.test', ARRIVAL)
    // The wait expires before the scripted service answers: the decision goes
    // ahead on the assignment the thread has now, which notifies nobody.
    manual.fire(SPLIT_TRIAGE_NOTIFY_WAIT_MS)
    await flushPromises()
    expect(notificationEvents(events)).toEqual([{ subjects: [], messageIds: [] }])

    await runtime.internal('test', [TEST_CHANNELS.runTriagePass])
    await flushMicrotasks()
    expect(notificationEvents(events)).toEqual([
      { subjects: [], messageIds: [] },
      { subjects: ['Alpha roadmap'], messageIds: ['m-alpha-2'] }
    ])

    // A later poll that reports the same arrival again says nothing: the late
    // judgment already announced that message.
    historyEvents.emit('newMail', 'primary@attn.test', ARRIVAL)
    await flushMicrotasks()
    expect(notificationEvents(events)).toEqual([
      { subjects: [], messageIds: [] },
      { subjects: ['Alpha roadmap'], messageIds: ['m-alpha-2'] },
      { subjects: [], messageIds: [] }
    ])
  })

  it('stays quiet about an arrival a newer message has already replaced', async () => {
    const manual = new ManualRuntimeTimers()
    const input = makeInput()
    const { runtime, events } = await createRuntime(input, manual.time)
    await armTriage(runtime, { probability: 0.95 })
    appendReply(input.dbPath)

    historyEvents.emit('newMail', 'primary@attn.test', ARRIVAL)
    manual.fire(SPLIT_TRIAGE_NOTIFY_WAIT_MS)
    await flushPromises()
    expect(notificationEvents(events)).toEqual([{ subjects: [], messageIds: [] }])

    // A second reply lands while the first one's judgment is still in flight.
    appendReply(input.dbPath, 'm-alpha-3')
    historyEvents.emit('newMail', 'primary@attn.test', [{ threadId: 't-alpha', messageId: 'm-alpha-3' }])

    await runtime.internal('test', [TEST_CHANNELS.runTriagePass])
    await flushMicrotasks()

    // The late judgment of m-alpha-2 announces nothing — that arrival is no
    // longer the one a notification would be about. m-alpha-3 has its own wait,
    // and its own judgment is what announces the conversation.
    expect(notificationEvents(events)).toEqual([
      { subjects: [], messageIds: [] },
      { subjects: ['Alpha roadmap'], messageIds: ['m-alpha-3'] }
    ])
  })

  it('stays quiet when a late judgment lands on a message that already notified', async () => {
    const manual = new ManualRuntimeTimers()
    const input = makeInput()
    const { runtime, events } = await createRuntime(input, manual.time)
    // Here the unjudged thread already sits in a split that notifies, so the
    // arrival notified on its own before the judgment landed.
    await armTriage(runtime, { probability: 0.95, notifyOther: true })
    appendReply(input.dbPath)

    historyEvents.emit('newMail', 'primary@attn.test', ARRIVAL)
    manual.fire(SPLIT_TRIAGE_NOTIFY_WAIT_MS)
    await flushPromises()
    expect(notificationEvents(events)).toEqual([{ subjects: ['Alpha roadmap'], messageIds: ['m-alpha-2'] }])

    await runtime.internal('test', [TEST_CHANNELS.runTriagePass])
    await flushMicrotasks()
    // The judgment moved the thread; it does not announce it a second time.
    expect(notificationEvents(events)).toEqual([{ subjects: ['Alpha roadmap'], messageIds: ['m-alpha-2'] }])
  })

  it('surfaces notification candidates for inactive accounts, roster members only', async () => {
    const input = makeInput()
    const { runtime, events } = await createRuntime(input)
    expect(runtime.ready().activeAccountId).toBe('primary@attn.test')

    // A poll cycle on the *inactive* account must still notify (F12/F18). The
    // seeded thread is IMPORTANT, the one starter split with notify on.
    historyEvents.emit('newMail', 'second@attn.test', [{ threadId: 't-beta', messageId: 'm-beta' }])
    const candidates = events.filter((event) => event.kind === 'notification-candidates').at(-1)
    expect(candidates?.kind === 'notification-candidates' ? candidates.accountId : null).toBe(
      'second@attn.test'
    )
    expect(
      candidates?.kind === 'notification-candidates'
        ? candidates.candidates.map((candidate) => candidate.subject)
        : []
    ).toEqual(['Beta launch'])

    // Mail for an account with no session stays silent.
    const before = events.filter((event) => event.kind === 'notification-candidates').length
    historyEvents.emit('newMail', 'ghost@attn.test', [{ threadId: 't-ghost', messageId: 'm-ghost' }])
    expect(events.filter((event) => event.kind === 'notification-candidates')).toHaveLength(before)
  })

  it('acknowledges a roster update only once deferred sessions exist, and switches wait for them', async () => {
    const input = makeInput()
    const { runtime } = await createRuntime(input)

    // Remove the active account, then re-add it through the awaited operation
    // main uses: the answer must name a session that actually exists, so the
    // published AuthStatus can never point at a still-retiring account.
    pushAccounts(runtime, {
      config: null,
      accounts: [],
      activeAccountId: null,
      seedAccountIds: ['second@attn.test']
    })
    const active = await runtime.internal('apply-accounts', [
      {
        config: null,
        accounts: [],
        activeAccountId: 'primary@attn.test',
        seedAccountIds: ['primary@attn.test', 'second@attn.test']
      }
    ])
    expect(active).toBe('primary@attn.test')
    expect(runtime.ready().accountIds).toContain('primary@attn.test')
    expect(await listInboxSubjects(runtime)).toEqual(['Alpha roadmap'])

    // And a switch aimed at a still-pending session waits instead of failing.
    pushAccounts(runtime, {
      config: null,
      accounts: [],
      activeAccountId: null,
      seedAccountIds: ['second@attn.test']
    })
    pushAccounts(runtime, {
      config: null,
      accounts: [],
      activeAccountId: null,
      seedAccountIds: ['primary@attn.test', 'second@attn.test']
    })
    expect(runtime.ready().accountIds).toEqual(['second@attn.test'])
    expect(await runtime.internal('set-active-account', ['primary@attn.test'])).toBe('primary@attn.test')
    expect(await listInboxSubjects(runtime)).toEqual(['Alpha roadmap'])
  })

  it('resumes auth-paused actions for the account that reauthenticated, not the active one', async () => {
    const input = makeInput()
    const { runtime } = await createRuntime(input)
    expect(runtime.ready().activeAccountId).toBe('primary@attn.test')

    // Auth-paused rows on both accounts, written the way the executor stores
    // them. Sign-in no longer activates the reconnected account, so the resume
    // must follow the flow's account id rather than the active pointer.
    const db = openDatabase(input.dbPath)
    const insert = db.prepare(
      `INSERT INTO action_queue (account_id, kind, thread_id, payload, state, attempts, last_error)
       VALUES (?, 'archive', ?, '{}', 'pending', 3, ?)`
    )
    const authError = storeActionError(new Error('invalid_grant'), 'auth')
    insert.run('primary@attn.test', 't-alpha', authError)
    insert.run('second@attn.test', 't-beta', authError)
    db.close()

    expect(await runtime.internal('resume-auth-failures', ['second@attn.test'])).toBe(1)
    const states = openDatabase(input.dbPath)
    const rows = states
      .prepare('SELECT account_id, attempts, last_error FROM action_queue ORDER BY account_id')
      .all() as Array<{ account_id: string; attempts: number; last_error: string | null }>
    states.close()
    // Only the reconnected account's row loses its auth marker and retry count.
    expect(rows).toEqual([
      { account_id: 'primary@attn.test', attempts: 3, last_error: authError },
      { account_id: 'second@attn.test', attempts: 0, last_error: null }
    ])

    // Without an explicit account the operation still serves the active one.
    expect(await runtime.internal('resume-auth-failures', [])).toBe(1)
  })

  it('defers re-creating a re-added account until its predecessor workers retire', async () => {
    const input = makeInput()
    const { runtime } = await createRuntime(input)

    // Remove and immediately re-add the same account: the removal's draft and
    // outbox workers are still quiescing, so a second session for the same
    // rows must not exist yet — two executor sets could double a
    // non-idempotent remote draft create.
    pushAccounts(runtime, {
      config: null,
      accounts: [],
      activeAccountId: null,
      seedAccountIds: ['second@attn.test']
    })
    pushAccounts(runtime, {
      config: null,
      accounts: [],
      activeAccountId: 'primary@attn.test',
      seedAccountIds: ['primary@attn.test', 'second@attn.test']
    })
    expect(runtime.ready().accountIds).toEqual(['second@attn.test'])

    // Once the retirement settles, the successor session appears and the
    // requested active account takes effect.
    await expect
      .poll(() => runtime.ready().accountIds.includes('primary@attn.test'), { timeout: 2000 })
      .toBe(true)
    expect(runtime.ready().activeAccountId).toBe('primary@attn.test')
    expect(await listInboxSubjects(runtime)).toEqual(['Alpha roadmap'])
  })

  it('binds reply drafts to the source thread’s owner and never across accounts', async () => {
    const input = makeInput()
    const { runtime } = await createRuntime(input)
    expect(runtime.ready().activeAccountId).toBe('primary@attn.test')

    // The race A5 guards: the active account changed between reader open and
    // R. The other account's thread must not produce a draft bound anywhere.
    expect(await runtime.invoke(IPC_CHANNELS.draftCreateReply, ['t-beta', 'reply', 'normal'])).toBeNull()
    const db = openDatabase(input.dbPath)
    expect(db.prepare('SELECT COUNT(*) AS count FROM outbox').get()).toEqual({ count: 0 })
    db.close()

    // A reply in a reachable flow binds explicitly to the thread's owner —
    // the draft carries its account and the composer renders that (F6).
    const draft = (await runtime.invoke(IPC_CHANNELS.draftCreateReply, ['t-alpha', 'reply', 'normal'])) as {
      accountId: string
      threadId: string
    } | null
    expect(draft?.accountId).toBe('primary@attn.test')
    expect(draft?.threadId).toBe('t-alpha')
  })

  it('reports per-account menu statuses for the whole roster', async () => {
    const input = makeInput()
    const { runtime } = await createRuntime(input)

    // Seeded controllers are idle → Live; unread follows badge semantics.
    expect(await runtime.invoke(IPC_CHANNELS.accountsGetStatuses, [])).toEqual([
      { accountId: 'primary@attn.test', phase: 'live', unread: 1 },
      { accountId: 'second@attn.test', phase: 'live', unread: 2 }
    ])

    // An auth-paused queue on a background account surfaces as Reconnect.
    const db = openDatabase(input.dbPath)
    db.prepare(
      `INSERT INTO action_queue (account_id, kind, thread_id, payload, state, attempts, last_error)
       VALUES ('second@attn.test', 'archive', 't-beta', '{}', 'pending', 3, ?)`
    ).run(storeActionError(new Error('invalid_grant'), 'auth'))
    db.close()
    const statuses = (await runtime.invoke(IPC_CHANNELS.accountsGetStatuses, [])) as Array<{
      accountId: string
      phase: string
    }>
    expect(statuses.map((status) => status.phase)).toEqual(['live', 'reconnect'])
  })

  it('adding an account leaves the first account’s cursors byte-identical', async () => {
    const input = makeInput()
    const { runtime } = await createRuntime(input)

    // Reduce the roster to the primary account alone, then snapshot every
    // cursor and derived sync column it owns.
    await runtime.internal('apply-accounts', [
      { config: null, accounts: [], activeAccountId: null, seedAccountIds: ['primary@attn.test'] }
    ])
    const snapshot = (): unknown => {
      const db = openDatabase(input.dbPath)
      const row = db.prepare("SELECT * FROM sync_state WHERE account_id = 'primary@attn.test'").get()
      db.close()
      return JSON.stringify(row)
    }
    const before = snapshot()

    // Adding the second account must not touch the first account's sync rows
    // in any way — no cursor reset, no re-backfill (F18 acceptance criteria).
    await runtime.internal('apply-accounts', [
      {
        config: null,
        accounts: [],
        activeAccountId: null,
        seedAccountIds: ['primary@attn.test', 'second@attn.test']
      }
    ])
    expect(runtime.ready().accountIds).toContain('second@attn.test')
    expect(snapshot()).toEqual(before)
  })

  it('re-adding a kept account resumes its dormant rows and cursors, not a fresh backfill', async () => {
    const input = makeInput()
    const { runtime } = await createRuntime(input)
    const syncStateRow = (): unknown => {
      const db = openDatabase(input.dbPath)
      const row = db.prepare("SELECT * FROM sync_state WHERE account_id = 'second@attn.test'").get()
      db.close()
      return JSON.stringify(row)
    }
    const dormantCursor = syncStateRow()

    // Remove with Keep: the roster loses the account, the rows stay.
    await runtime.internal('apply-accounts', [
      { config: null, accounts: [], activeAccountId: null, seedAccountIds: ['primary@attn.test'] }
    ])
    expect(runtime.ready().accountIds).toEqual(['primary@attn.test'])
    expect(syncStateRow()).toEqual(dormantCursor)

    // Re-adding the same address resumes from the stored cursors (D3 Keep).
    await runtime.internal('apply-accounts', [
      {
        config: null,
        accounts: [],
        activeAccountId: 'second@attn.test',
        seedAccountIds: ['primary@attn.test', 'second@attn.test']
      }
    ])
    expect(runtime.ready().activeAccountId).toBe('second@attn.test')
    expect(await listInboxSubjects(runtime)).toEqual(['Beta launch', 'Beta digest'])
    expect(syncStateRow()).toEqual(dormantCursor)
  })

  it('purges a removed account’s rows through the remove-account-data operation', async () => {
    const input = makeInput()
    const { runtime } = await createRuntime(input)

    // The roster update precedes the purge; a still-live session is refused.
    await expect(runtime.internal('remove-account-data', ['second@attn.test'])).rejects.toThrow(
      'account session still active'
    )
    await runtime.internal('apply-accounts', [
      { config: null, accounts: [], activeAccountId: null, seedAccountIds: ['primary@attn.test'] }
    ])
    await runtime.internal('remove-account-data', ['second@attn.test'])

    const db = openDatabase(input.dbPath)
    const gone = db
      .prepare("SELECT COUNT(*) AS count FROM threads WHERE account_id = 'second@attn.test'")
      .get()
    const roster = db.prepare("SELECT COUNT(*) AS count FROM accounts WHERE id = 'second@attn.test'").get()
    const survivor = db
      .prepare("SELECT COUNT(*) AS count FROM threads WHERE account_id = 'primary@attn.test'")
      .get()
    db.close()
    expect(gone).toEqual({ count: 0 })
    expect(roster).toEqual({ count: 0 })
    expect(survivor).toEqual({ count: 1 })
  })

  it('waits for spool deletion before purging rows or recreating the removed session', async () => {
    const { runtime, db, drafts } = await prepareAttachmentRemoval()
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const deleting = new Promise<void>((resolve) => {
      started = resolve
    })
    const remove = spool.deleteOutboxSpool
    vi.spyOn(spool, 'deleteOutboxSpool').mockImplementationOnce(async (...args) => {
      started()
      await gate
      await remove(...args)
    })
    let settled = false
    const deletion = runtime.internal('remove-account-data', ['second@attn.test']).then(() => {
      settled = true
    })
    let readd: Promise<unknown> | undefined
    try {
      await deleting
      expect(settled).toBe(false)
      expect(db.prepare('SELECT id FROM outbox WHERE id = ?').get(drafts[1].id)).toBeDefined()
      expect(existsSync(drafts[1].directory)).toBe(true)

      readd = runtime.internal('apply-accounts', [
        {
          config: null,
          accounts: [],
          activeAccountId: 'second@attn.test',
          seedAccountIds: ['primary@attn.test', 'second@attn.test']
        }
      ])
      expect(runtime.ready().accountIds).not.toContain('second@attn.test')
    } finally {
      release()
    }
    await deletion
    await readd
    expect(runtime.ready().activeAccountId).toBe('second@attn.test')
    expect(await listInboxSubjects(runtime)).toEqual([])
    expect(db.prepare('SELECT id FROM outbox WHERE id = ?').get(drafts[1].id)).toBeUndefined()
    expect(existsSync(drafts[1].directory)).toBe(false)
    expect(existsSync(drafts[0].directory)).toBe(true)
  })

  it('rejects failed spool deletion without losing the account records needed for a retry', async () => {
    const { runtime, db, drafts } = await prepareAttachmentRemoval()
    vi.spyOn(spool, 'deleteOutboxSpool').mockRejectedValueOnce(new Error('EACCES: attachment is locked'))
    await expect(runtime.internal('remove-account-data', ['second@attn.test'])).rejects.toThrow('EACCES')
    expect(db.prepare('SELECT id FROM accounts WHERE id = ?').get('second@attn.test')).toBeDefined()
    expect(db.prepare('SELECT id FROM outbox WHERE id = ?').get(drafts[1].id)).toBeDefined()
    expect(existsSync(drafts[1].directory)).toBe(true)
    expect(await listInboxSubjects(runtime)).toEqual(['Alpha roadmap'])

    await runtime.internal('remove-account-data', ['second@attn.test'])
    expect(db.prepare('SELECT id FROM accounts WHERE id = ?').get('second@attn.test')).toBeUndefined()
    expect(db.prepare('SELECT id FROM outbox WHERE id = ?').get(drafts[1].id)).toBeUndefined()
    expect(existsSync(drafts[1].directory)).toBe(false)
    expect(existsSync(drafts[0].directory)).toBe(true)
  })

  it('retires a removed seed session and falls back to the survivor', async () => {
    const input = makeInput()
    const { runtime } = await createRuntime(input)
    await runtime.internal('set-active-account', ['second@attn.test'])

    pushAccounts(runtime, {
      config: null,
      accounts: [],
      activeAccountId: null,
      seedAccountIds: ['primary@attn.test']
    })
    expect(runtime.ready().accountIds).toEqual(['primary@attn.test'])
    expect(runtime.ready().activeAccountId).toBe('primary@attn.test')
    expect(await listInboxSubjects(runtime)).toEqual(['Alpha roadmap'])
  })
})

describe('IndexingSlot', () => {
  it('grants the slot to the account that is active at release time', async () => {
    let active = 'a'
    const slot = new IndexingSlot((accountId) => accountId === active)
    const releaseA = await slot.acquire('a')

    const grants: string[] = []
    const waiters = ['b', 'c'].map((accountId) =>
      slot.acquire(accountId).then((release) => {
        grants.push(accountId)
        release()
      })
    )

    // The user switches to c while it is already queued behind b. Priority is
    // decided at hand-over, so c must run its chain before b.
    active = 'c'
    releaseA()
    await Promise.all(waiters)
    expect(grants).toEqual(['c', 'b'])
  })

  it('falls back to arrival order when no waiter is active', async () => {
    const slot = new IndexingSlot(() => false)
    const releaseA = await slot.acquire('a')
    const grants: string[] = []
    const waiters = ['b', 'c'].map((accountId) =>
      slot.acquire(accountId).then((release) => {
        grants.push(accountId)
        release()
      })
    )
    releaseA()
    await Promise.all(waiters)
    expect(grants).toEqual(['b', 'c'])
  })

  it('asks the holder to yield only while the active account is actually waiting', async () => {
    let active = 'b'
    const slot = new IndexingSlot((accountId) => accountId === active)
    const releaseA = await slot.acquire('a')

    // Nobody waits yet: no preemption ask.
    expect(slot.hasPriorityWaiter('a')).toBe(false)

    // An inactive waiter queues: still no ask.
    const waiterC = slot.acquire('c')
    expect(slot.hasPriorityWaiter('a')).toBe(false)

    // The active account queues: the holder must yield at its next boundary.
    const waiterB = slot.acquire('b')
    expect(slot.hasPriorityWaiter('a')).toBe(true)
    // Only the holder is asked — other accounts read false.
    expect(slot.hasPriorityWaiter('b')).toBe(false)
    expect(slot.hasPriorityWaiter('c')).toBe(false)

    // A holder that *is* the active account is never asked to yield.
    active = 'a'
    expect(slot.hasPriorityWaiter('a')).toBe(false)

    active = 'b'
    releaseA()
    const releaseB = await waiterB
    expect(slot.hasPriorityWaiter('b')).toBe(false)
    releaseB()
    ;(await waiterC)()
  })
})
