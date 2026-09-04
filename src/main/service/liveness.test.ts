import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyDraftInput } from '../../shared/drafts'
import { ActionExecutor } from '../actions/executor'
import { type Db, openDatabase } from '../db'
import type { GmailMailProvider } from '../gmail/provider'
import { saveDraft } from '../outbox/drafts'
import { queueSend } from '../outbox/queue'
import { OutboxSender } from '../outbox/sender'
import { SnoozeScheduler } from '../scheduler'
import { HistoryPoller } from '../sync/poller'
import type { MailProvider } from '../sync/provider'
import { SyncController } from '../syncController'
import type { SchedulerTime, TimerHandle } from '../time'
import { IndexingSlot } from './runtime'

// A2's cross-account liveness contract (F18, §9 #21(b)): every worker is
// wired exactly as ServiceRuntime.createSession binds it — an `accountId()`
// callback answering its own account while the session exists — so an
// inactive account's queues, deadlines, and reminders stay live no matter
// which account the UI shows. These tests build that wiring against a real
// SQLite store and mock providers; wall-clock never runs (ManualTime).

const NOW = 1_700_000_000_000

class ManualTime implements SchedulerTime {
  private nextId = 1
  private readonly scheduled = new Map<number, { at: number; callback: () => void }>()

  constructor(private current = NOW) {}

  now = (): number => this.current

  timers = {
    setTimeout: (callback: () => void, delayMs: number): TimerHandle => {
      const id = this.nextId++
      this.scheduled.set(id, { at: this.current + delayMs, callback })
      return id as unknown as TimerHandle
    },
    clearTimeout: (handle: TimerHandle): void => {
      this.scheduled.delete(handle as unknown as number)
    }
  }

  advance(ms: number): void {
    this.current += ms
    for (;;) {
      const due = [...this.scheduled.entries()]
        .filter(([, timer]) => timer.at <= this.current)
        .sort(([, left], [, right]) => left.at - right.at)[0]
      if (!due) return
      this.scheduled.delete(due[0])
      due[1].callback()
    }
  }
}

const ACCOUNT_A = 'a@attn.test'
const ACCOUNT_B = 'b@attn.test'

function seedAccounts(db: Db): void {
  const insert = db.prepare('INSERT INTO accounts (id, email) VALUES (?, ?)')
  insert.run(ACCOUNT_A, ACCOUNT_A)
  insert.run(ACCOUNT_B, ACCOUNT_B)
}

function mockProvider(overrides: Partial<MailProvider> = {}): MailProvider {
  return {
    modifyThread: vi.fn(),
    getProfile: vi.fn(),
    listLabels: vi.fn(),
    listThreadIds: vi.fn(),
    getThread: vi.fn(),
    getAttachmentData: vi.fn(),
    listHistory: vi.fn(),
    listDrafts: vi.fn(),
    getDraft: vi.fn(),
    saveDraft: vi.fn(),
    createDraft: vi.fn(async () => 'created-draft'),
    updateDraft: vi.fn(async ({ id }) => id),
    sendDraft: vi.fn(async () => ({ id: 'sent-message', threadId: 'sent-thread' })),
    findByRfcId: vi.fn(),
    ...overrides
  } as MailProvider
}

describe('multi-account liveness', () => {
  let dir: string | null = null

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it('sends a queued message on the inactive account at its deadline', async () => {
    const db = openDatabase(':memory:')
    seedAccounts(db)
    const time = new ManualTime()

    // The user queues a send on B, then switches to A. The runtime keeps B's
    // sender alive and bound to B; the deadline must fire regardless.
    const draftId = saveDraft(
      db,
      ACCOUNT_B,
      { ...emptyDraftInput(), to: [{ name: '', email: 'x@example.com' }], subject: 'Deadline' },
      time.now()
    )
    const { sendAt } = queueSend(db, ACCOUNT_B, draftId, time.now())
    expect(sendAt).toBe(time.now() + 5_000)

    const providerB = mockProvider()
    const senderB = new OutboxSender(
      db,
      () => ACCOUNT_B,
      () => providerB,
      () => {},
      { time, spoolRoot: null }
    )
    senderB.start()

    time.advance(5_000)
    await senderB.trigger()

    expect(providerB.sendDraft).toHaveBeenCalledTimes(1)
    const row = db.prepare('SELECT state, account_id FROM outbox WHERE id = ?').get(draftId) as {
      state: string
      account_id: string
    }
    expect(row).toEqual({ state: 'sent', account_id: ACCOUNT_B })
    await senderB.stop()
    db.close()
  })

  it('returns a due snooze on the inactive account and queues only its own action', () => {
    const db = openDatabase(':memory:')
    seedAccounts(db)
    const time = new ManualTime()
    db.prepare(
      `INSERT INTO threads (account_id, id, subject, last_msg_at, is_unread, is_inbox_visible)
       VALUES (?, 't-snoozed', 'Snoozed on B', 1, 0, 0)`
    ).run(ACCOUNT_B)
    db.prepare(
      `INSERT INTO reminders (account_id, thread_id, kind, due_at, state) VALUES (?, 't-snoozed', 'snooze', ?, 'pending')`
    ).run(ACCOUNT_B, time.now() + 60_000)
    // A's own future reminder must stay untouched by B's wake.
    db.prepare(
      `INSERT INTO reminders (account_id, thread_id, kind, due_at, state) VALUES (?, 't-a', 'snooze', ?, 'pending')`
    ).run(ACCOUNT_A, time.now() + 500_000)

    const changed = vi.fn()
    const queueChanged = vi.fn()
    const schedulerB = new SnoozeScheduler(db, () => ACCOUNT_B, changed, queueChanged, time)
    schedulerB.start()
    expect(changed).not.toHaveBeenCalled()

    time.advance(60_000)

    expect(changed).toHaveBeenCalled()
    expect(queueChanged).toHaveBeenCalled()
    const reminders = db
      .prepare('SELECT account_id, state FROM reminders ORDER BY account_id')
      .all() as Array<{ account_id: string; state: string }>
    expect(reminders).toEqual([
      { account_id: ACCOUNT_A, state: 'pending' },
      { account_id: ACCOUNT_B, state: 'returned' }
    ])
    const queued = db.prepare('SELECT account_id, kind, thread_id FROM action_queue').all()
    expect(queued).toEqual([{ account_id: ACCOUNT_B, kind: 'modifyLabels', thread_id: 't-snoozed' }])
    schedulerB.stop()
    db.close()
  })

  it('drains an offline queue for one account after relaunch without touching the other', async () => {
    dir = mkdtempSync(join(tmpdir(), 'attn-liveness-'))
    const dbPath = join(dir, 'attn.db')
    {
      // First launch: actions queue up on A while offline, then the app quits.
      const db = openDatabase(dbPath)
      seedAccounts(db)
      db.prepare(
        `INSERT INTO action_queue (account_id, kind, thread_id, payload, state)
         VALUES (?, 'modifyLabels', 't-a-archive', ?, 'pending')`
      ).run(ACCOUNT_A, JSON.stringify({ add: [], remove: ['INBOX'], actionKind: 'archive' }))
      db.close()
    }

    // Relaunch: fresh executors per account, exactly as the runtime creates
    // them. A is *not* the active account on screen — that must not matter.
    const db = openDatabase(dbPath)
    const providerA = mockProvider()
    const providerB = mockProvider()
    const executorA = new ActionExecutor(
      db,
      () => ACCOUNT_A,
      () => providerA
    )
    const executorB = new ActionExecutor(
      db,
      () => ACCOUNT_B,
      () => providerB
    )

    await Promise.all([executorA.trigger(), executorB.trigger()])

    expect(providerA.modifyThread).toHaveBeenCalledWith('t-a-archive', [], ['INBOX'])
    expect(providerB.modifyThread).not.toHaveBeenCalled()
    expect(providerB.getThread).not.toHaveBeenCalled()
    expect(db.prepare('SELECT COUNT(*) AS count FROM action_queue').get()).toEqual({ count: 0 })
    executorA.stop()
    executorB.stop()
    db.close()
  })

  it('hands the indexing slot to the active account at a page boundary and resumes the preempted cursor', async () => {
    const db = openDatabase(':memory:')
    seedAccounts(db)
    const insertState = db.prepare(
      "INSERT INTO sync_state (account_id, last_history_id, backfill_cursor) VALUES (?, '1', 'done')"
    )
    insertState.run(ACCOUNT_A)
    insertState.run(ACCOUNT_B)

    // A is the active account throughout; B's historical chain is running.
    const slot = new IndexingSlot((accountId) => accountId === ACCOUNT_A)
    const events: string[] = []
    let releaseGate!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseGate = resolve
    })

    const thread = (id: string): { id: string; messages: [] } => ({ id, messages: [] })
    // The attachment-flag and split-metadata tails list with `q`/`labelIds`;
    // only the plain listings below are the lifetime sweep's own pages.
    type ListOptions = { pageToken?: string; q?: string; labelIds?: string[] }
    const providerB = mockProvider({
      getProfile: vi.fn(async () => ({
        emailAddress: ACCOUNT_B,
        historyId: '1',
        threadsTotal: 2,
        messagesTotal: 2
      })),
      listThreadIds: vi.fn(async (options: ListOptions = {}) => {
        if (options.q || options.labelIds) return { threadIds: [] }
        events.push(`b:sweep:${options.pageToken ?? 'start'}`)
        if (options.pageToken) {
          // Hold B's second page open until the active account has queued for
          // the slot, so the page-1 cursor is durable when preemption lands.
          await gate
          return { threadIds: ['tb2'] }
        }
        return { threadIds: ['tb1'], nextPageToken: 'p2' }
      }),
      getThread: vi.fn(async (id: string) => thread(id))
    }) as unknown as GmailMailProvider
    const providerA = mockProvider({
      getProfile: vi.fn(async () => ({
        emailAddress: ACCOUNT_A,
        historyId: '1',
        threadsTotal: 1,
        messagesTotal: 1
      })),
      listThreadIds: vi.fn(async (options: ListOptions = {}) => {
        if (options.q || options.labelIds) return { threadIds: [] }
        events.push(`a:sweep:${options.pageToken ?? 'start'}`)
        return { threadIds: ['ta1'] }
      }),
      getThread: vi.fn(async (id: string) => thread(id))
    }) as unknown as GmailMailProvider

    const makeController = (accountId: string, provider: GmailMailProvider): SyncController =>
      new SyncController({
        db,
        currentAccountId: () => accountId,
        isSignedIn: () => true,
        isSeeded: () => false,
        makeProvider: () => provider,
        isForeground: () => false,
        hasForegroundProviderWork: () => false,
        mailRevision: () => 0,
        broadcastState: () => {},
        broadcastMailChanged: () => {},
        getActionExecutor: () => null,
        getDraftMirrorExecutor: () => null,
        getOutboxSender: () => null,
        getSnoozeScheduler: () => null,
        acquireIndexingSlot: (id) => slot.acquire(id),
        shouldPreemptIndexing: (id) => slot.hasPriorityWaiter(id),
        lifetimePacing: { requestIntervalMs: 0, pagePauseMs: 0, foregroundYieldMs: 0 }
      })
    const controllerB = makeController(ACCOUNT_B, providerB)
    const controllerA = makeController(ACCOUNT_A, providerA)

    const sweepCursor = (accountId: string): string | null =>
      (
        db.prepare('SELECT sweep_cursor FROM sync_state WHERE account_id = ?').get(accountId) as {
          sweep_cursor: string | null
        }
      ).sweep_cursor

    await controllerB.resumeOnlineWork()
    await expect.poll(() => events).toContain('b:sweep:p2')
    // The active account arrives while B holds the slot between pages.
    await controllerA.resumeOnlineWork()
    releaseGate()

    await expect.poll(() => sweepCursor(ACCOUNT_A), { timeout: 5_000 }).toBe('done')
    await expect.poll(() => sweepCursor(ACCOUNT_B), { timeout: 5_000 }).toBe('done')
    // B checkpointed page one, yielded the slot at the boundary, A ran its
    // whole chain, then B resumed from its durable cursor — page two, not
    // page one (F18 §9 #21(g)).
    expect(events).toEqual(['b:sweep:start', 'b:sweep:p2', 'a:sweep:start', 'b:sweep:p2'])
    controllerA.stop()
    controllerB.stop()
    db.close()
  })

  it('polls two accounts independently, each on its own cadence and cursor', async () => {
    const db = openDatabase(':memory:')
    seedAccounts(db)
    db.prepare('INSERT INTO sync_state (account_id, last_history_id) VALUES (?, ?)').run(ACCOUNT_A, '100')
    db.prepare('INSERT INTO sync_state (account_id, last_history_id) VALUES (?, ?)').run(ACCOUNT_B, '200')
    const time = new ManualTime()

    const cursor = (accountId: string): string =>
      (
        db.prepare('SELECT last_history_id FROM sync_state WHERE account_id = ?').get(accountId) as {
          last_history_id: string
        }
      ).last_history_id

    const cycles = { a: 0, b: 0 }
    const providerA = mockProvider({
      listHistory: vi.fn(async () => {
        cycles.a++
        return { history: [], historyId: String(100 + cycles.a) }
      })
    })
    const providerB = mockProvider({
      listHistory: vi.fn(async () => {
        cycles.b++
        return { history: [], historyId: String(200 + cycles.b) }
      })
    })
    const makePoller = (accountId: string, provider: MailProvider, foreground: boolean): HistoryPoller =>
      new HistoryPoller({
        db,
        accountId,
        provider,
        // A is on screen (15s cadence); B polls at the background 60s cadence.
        isForeground: () => foreground,
        recoverExpiredHistory: async () => {},
        onCycleComplete: () => {},
        onError: () => {},
        time
      })
    const pollerA = makePoller(ACCOUNT_A, providerA, true)
    const pollerB = makePoller(ACCOUNT_B, providerB, false)
    pollerA.start()
    pollerB.start()

    time.advance(15_000)
    await expect.poll(() => cursor(ACCOUNT_A)).toBe('101')
    // B's background cadence has not elapsed: its cursor must be untouched.
    expect(cursor(ACCOUNT_B)).toBe('200')

    time.advance(15_000)
    await expect.poll(() => cursor(ACCOUNT_A)).toBe('102')
    time.advance(15_000)
    await expect.poll(() => cursor(ACCOUNT_A)).toBe('103')
    time.advance(15_000)
    await expect.poll(() => cursor(ACCOUNT_B)).toBe('201')
    await expect.poll(() => cursor(ACCOUNT_A)).toBe('104')

    pollerA.stop()
    pollerB.stop()
    db.close()
  })
})
