import { describe, expect, it, vi } from 'vitest'
import type { OutboxChanged } from '../../shared/outbox'
import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import type { MailProvider } from '../sync/provider'
import type { SchedulerTime, TimerHandle } from '../time'
import {
  executeDraftSendProtocol,
  isRetryableOutboxPreflightError,
  OutboxSender,
  SENT_OUTBOX_RETENTION_MS,
  verifyKnownDraft
} from './sender'

function provider(overrides: Partial<MailProvider> = {}): MailProvider {
  return {
    modifyThread: vi.fn(),
    trashThread: vi.fn(),
    untrashThread: vi.fn(),
    getProfile: vi.fn(),
    listLabels: vi.fn(),
    listThreadIds: vi.fn(),
    getThread: vi.fn(),
    getAttachmentData: vi.fn(),
    listHistory: vi.fn(),
    listDrafts: vi.fn(),
    getDraft: vi.fn(async (id) => ({ id, message: { id: `message-${id}`, threadId: 'thread-1' } })),
    saveDraft: vi.fn(async ({ id }) => id ?? 'created-draft'),
    createDraft: vi.fn(async () => 'created-draft'),
    updateDraft: vi.fn(async ({ id }) => id),
    sendDraft: vi.fn(async () => ({ id: 'sent-message', threadId: 'sent-thread' })),
    findByRfcId: vi.fn(),
    ...overrides
  }
}

describe('outbox Gmail draft protocol', () => {
  it('creates, persists, updates, then sends in that exact order', async () => {
    const order: string[] = []
    const fake = provider({
      createDraft: vi.fn(async () => {
        order.push('create')
        return 'created-draft'
      }),
      updateDraft: vi.fn(async ({ id }) => {
        order.push(`update:${id}`)
        return id
      }),
      sendDraft: vi.fn(async (id) => {
        order.push(`send:${id}`)
        return { id: 'sent-message', threadId: 'sent-thread' }
      })
    })

    await expect(
      executeDraftSendProtocol(fake, {
        gmailDraftId: null,
        raw: 'raw',
        threadId: 'thread-1',
        persistCreatedId: (id) => {
          order.push(`persist:${id}`)
          return true
        }
      })
    ).resolves.toEqual({ kind: 'sent', threadId: 'sent-thread' })
    expect(order).toEqual(['create', 'persist:created-draft', 'update:created-draft', 'send:created-draft'])
  })

  it('never updates or sends when a crash/error prevents id persistence', async () => {
    const createDraft = vi.fn(async () => 'orphaned-draft')
    const updateDraft = vi.fn(async ({ id }: { id: string }) => id)
    const sendDraft = vi.fn(async () => ({ id: 'sent', threadId: 'thread' }))
    const fake = provider({ createDraft, updateDraft, sendDraft })

    await expect(
      executeDraftSendProtocol(fake, {
        gmailDraftId: null,
        raw: 'raw',
        threadId: null,
        persistCreatedId: () => false
      })
    ).resolves.toEqual({ kind: 'aborted' })
    expect(createDraft).toHaveBeenCalledTimes(1)
    expect(updateDraft).not.toHaveBeenCalled()
    expect(sendDraft).not.toHaveBeenCalled()
  })

  it('distinguishes a definitive retryable create rejection from an ambiguous create failure', async () => {
    const rejected = provider({
      createDraft: vi.fn(async () => {
        throw new GmailApiError(429, 'quota', true)
      })
    })
    await expect(
      executeDraftSendProtocol(rejected, {
        gmailDraftId: null,
        raw: 'raw',
        threadId: null,
        persistCreatedId: () => true
      })
    ).rejects.toMatchObject({
      reason: expect.objectContaining({ status: 429, retryable: true })
    })

    const ambiguous = new TypeError('fetch failed')
    const uncertain = provider({
      createDraft: vi.fn(async () => {
        throw ambiguous
      })
    })
    await expect(
      executeDraftSendProtocol(uncertain, {
        gmailDraftId: null,
        raw: 'raw',
        threadId: null,
        persistCreatedId: () => true
      })
    ).rejects.toBe(ambiguous)

    const timedOut = new GmailApiError(408, 'deadline exceeded', true)
    const timeout = provider({
      createDraft: vi.fn(async () => {
        throw timedOut
      })
    })
    await expect(
      executeDraftSendProtocol(timeout, {
        gmailDraftId: null,
        raw: 'raw',
        threadId: null,
        persistCreatedId: () => true
      })
    ).rejects.toBe(timedOut)
  })

  it('treats send 404 as an already-consumed draft, never a blind-resend signal', async () => {
    const fake = provider({
      sendDraft: vi.fn(async () => {
        throw new GmailApiError(404, 'gone')
      })
    })
    await expect(
      executeDraftSendProtocol(fake, {
        gmailDraftId: 'known-draft',
        raw: 'raw',
        threadId: null,
        persistCreatedId: () => true
      })
    ).resolves.toEqual({ kind: 'consumed' })
  })

  it('does not call send or claim success when the draft is missing during update', async () => {
    const sendDraft = vi.fn(async () => ({ id: 'sent', threadId: 'thread' }))
    const fake = provider({
      updateDraft: vi.fn(async () => {
        throw new GmailApiError(404, 'deleted before send')
      }),
      sendDraft
    })
    await expect(
      executeDraftSendProtocol(fake, {
        gmailDraftId: 'missing-draft',
        raw: 'raw',
        threadId: null,
        persistCreatedId: () => true
      })
    ).resolves.toEqual({ kind: 'missing-before-send' })
    expect(sendDraft).not.toHaveBeenCalled()
  })

  it('uses draft presence as the decisive recovery probe', async () => {
    await expect(verifyKnownDraft(provider(), 'present')).resolves.toBe('present')
    await expect(
      verifyKnownDraft(
        provider({
          getDraft: vi.fn(async () => {
            throw new GmailApiError(404, 'consumed')
          })
        }),
        'consumed'
      )
    ).resolves.toBe('consumed')
  })
})

describe('outbox preflight failures', () => {
  it('retries only errors that can recover without editing the message', () => {
    expect(isRetryableOutboxPreflightError(new TypeError('fetch failed'))).toBe(true)
    expect(isRetryableOutboxPreflightError(new GmailApiError(503, 'unavailable', true))).toBe(true)
    expect(isRetryableOutboxPreflightError(new Error('local attachment unavailable'))).toBe(false)
  })
})

type FakeSendState = 'composing' | 'queued' | 'sending' | 'sent' | 'failed' | 'needs-review'

interface FakeSendRow {
  id: string
  account_id: string
  state: FakeSendState
  kind: 'new'
  gmail_draft_id: string | null
  rfc_message_id: string
  to_json: string
  cc_json: string
  bcc_json: string
  subject: string
  body_html: string
  body_text: string
  attachments_json: string
  thread_id: string | null
  in_reply_to: string | null
  references_json: string
  quote_html: string
  quote_text: string
  updated_at: number
  send_at: number | null
  attempts: number
  verify_attempts: number
  last_error: string | null
}

const NOW = 10_000

function fakeRow(patch: Partial<FakeSendRow> = {}): FakeSendRow {
  return {
    id: 'outbox-1',
    account_id: 'me@example.com',
    state: 'queued',
    kind: 'new',
    gmail_draft_id: null,
    rfc_message_id: '<message@example.com>',
    to_json: JSON.stringify([{ name: '', email: 'to@example.com' }]),
    cc_json: '[]',
    bcc_json: '[]',
    subject: 'Effect layer',
    body_html: '<p>Hello</p>',
    body_text: 'Hello',
    attachments_json: '[]',
    thread_id: null,
    in_reply_to: null,
    references_json: '[]',
    quote_html: '',
    quote_text: '',
    updated_at: NOW,
    send_at: NOW,
    attempts: 0,
    verify_attempts: 0,
    last_error: null,
    ...patch
  }
}

class FakeOutboxDb {
  readonly rows = new Map<string, FakeSendRow>()
  readonly db = { prepare: (sql: string) => this.prepare(sql) } as unknown as Db

  constructor(...rows: FakeSendRow[]) {
    for (const row of rows) this.rows.set(row.id, row)
  }

  row(id = 'outbox-1'): FakeSendRow {
    const row = this.rows.get(id)
    if (!row) throw new Error(`missing fake row: ${id}`)
    return row
  }

  private prepare(sql: string): {
    get: (...args: unknown[]) => unknown
    run: (...args: unknown[]) => { changes: number }
  } {
    const query = sql.replace(/\s+/g, ' ').trim()
    return {
      get: (...args) => this.get(query, args),
      run: (...args) => this.run(query, args)
    }
  }

  private get(query: string, args: unknown[]): unknown {
    if (query.startsWith('SELECT state, send_at FROM outbox')) {
      const accountId = String(args[0])
      const row = [...this.rows.values()].find(
        (candidate) => candidate.account_id === accountId && ['queued', 'sending'].includes(candidate.state)
      )
      return row ? { state: row.state, send_at: row.send_at } : undefined
    }
    if (query.includes('LIMIT 1')) {
      const accountId = String(args[0])
      const now = Number(args[1])
      const row = [...this.rows.values()]
        .filter(
          (candidate) =>
            candidate.account_id === accountId &&
            ['queued', 'sending'].includes(candidate.state) &&
            (candidate.send_at === null || candidate.send_at <= now)
        )
        .sort((left, right) => Number(right.state === 'sending') - Number(left.state === 'sending'))[0]
      return row ? { ...row } : undefined
    }
    if (query.includes("AND id = ? AND state = 'sending'")) {
      const row = this.rows.get(String(args[1]))
      return row && row.account_id === args[0] && row.state === 'sending' ? { ...row } : undefined
    }
    throw new Error(`unexpected fake get: ${query}`)
  }

  private run(query: string, args: unknown[]): { changes: number } {
    if (query.startsWith("DELETE FROM outbox WHERE account_id = ? AND state = 'sent'")) {
      const accountId = String(args[0])
      const cutoff = Number(args[1])
      let changes = 0
      for (const [id, row] of this.rows) {
        if (row.account_id === accountId && row.state === 'sent' && row.updated_at < cutoff) {
          this.rows.delete(id)
          changes++
        }
      }
      return { changes }
    }
    if (query.startsWith("UPDATE outbox SET state = 'sending'")) {
      const row = this.rows.get(String(args[1]))
      if (!row || row.account_id !== args[0] || row.state !== 'queued') return { changes: 0 }
      row.state = 'sending'
      return { changes: 1 }
    }
    if (query.startsWith('UPDATE outbox SET gmail_draft_id = ?')) {
      const row = this.rows.get(String(args[2]))
      if (!row || row.account_id !== args[1] || row.state !== 'sending' || row.gmail_draft_id !== null) {
        return { changes: 0 }
      }
      row.gmail_draft_id = String(args[0])
      row.attempts = 0
      row.verify_attempts = 0
      row.last_error = null
      return { changes: 1 }
    }
    if (query.startsWith('UPDATE outbox SET state = ?, gmail_draft_id = CASE')) {
      const row = this.rows.get(String(args[6]))
      if (!row || row.account_id !== args[5] || row.state !== 'sending') return { changes: 0 }
      row.state = args[0] as FakeSendState
      if (Number(args[1])) row.gmail_draft_id = null
      row.send_at = null
      row.attempts = Number(args[2])
      row.verify_attempts = Number(args[3])
      row.last_error = String(args[4])
      return { changes: 1 }
    }
    if (query.startsWith('UPDATE outbox SET state = ?, send_at = ?, attempts = ?')) {
      const row = this.rows.get(String(args[6]))
      const requiresMissingDraft = query.includes('gmail_draft_id IS NULL')
      if (
        !row ||
        row.account_id !== args[5] ||
        row.state !== 'sending' ||
        (requiresMissingDraft && row.gmail_draft_id !== null)
      ) {
        return { changes: 0 }
      }
      row.state = args[0] as FakeSendState
      row.send_at = args[1] === null ? null : Number(args[1])
      row.attempts = Number(args[2])
      row.verify_attempts = Number(args[3])
      row.last_error = args[4] === null ? null : String(args[4])
      return { changes: 1 }
    }
    if (query.startsWith("UPDATE outbox SET state = 'sent'")) {
      const row = this.rows.get(String(args[2]))
      if (!row || row.account_id !== args[1] || row.state !== 'sending') return { changes: 0 }
      row.state = 'sent'
      row.send_at = null
      row.last_error = null
      row.updated_at = Number(args[0])
      return { changes: 1 }
    }
    throw new Error(`unexpected fake run: ${query}`)
  }
}

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

  nextDelay(): number | undefined {
    const next = [...this.scheduled.values()].sort((left, right) => left.at - right.at)[0]
    return next ? next.at - this.current : undefined
  }

  advance(ms: number): void {
    this.current += ms
    const due = [...this.scheduled.entries()].filter(([, timer]) => timer.at <= this.current)
    for (const [id, timer] of due) {
      this.scheduled.delete(id)
      timer.callback()
    }
  }
}

function effectProvider(overrides: Partial<MailProvider> = {}): MailProvider {
  return provider({
    sendDraft: vi.fn(async () => ({ id: 'sent-message', threadId: '' })),
    ...overrides
  })
}

function effectSender(
  store: FakeOutboxDb,
  remote: MailProvider,
  options: {
    time?: ManualTime
    notify?: (change: OutboxChanged) => void
    beforeRemote?: () => Promise<void>
    clean?: (id: string) => void
  } = {}
): OutboxSender {
  return new OutboxSender(
    store.db,
    () => 'me@example.com',
    () => remote,
    options.notify ?? vi.fn(),
    options.beforeRemote,
    options.time ?? new ManualTime(),
    null,
    options.clean
  )
}

describe('OutboxSender effect layer', () => {
  it('reports active delivery without treating an idle scheduler timer as running', async () => {
    let release!: () => void
    const checkpoint = new Promise<void>((resolve) => {
      release = resolve
    })
    const sender = effectSender(new FakeOutboxDb(fakeRow()), effectProvider(), {
      beforeRemote: () => checkpoint
    })

    const running = sender.trigger()
    expect(sender.isRunning()).toBe(true)
    release()
    await running
    expect(sender.isRunning()).toBe(false)
  })

  it('claims a due row once, persists its Gmail id, marks it sent, and cleans its spool', async () => {
    const store = new FakeOutboxDb(fakeRow())
    const clean = vi.fn()
    const createDraft = vi.fn(async () => 'draft-1')
    const updateDraft = vi.fn(async ({ id }: { id: string }) => id)
    const sendDraft = vi.fn(async () => ({ id: 'sent-message', threadId: '' }))
    const sender = effectSender(store, effectProvider({ createDraft, updateDraft, sendDraft }), { clean })

    await sender.trigger()

    expect(store.row()).toMatchObject({ state: 'sent', gmail_draft_id: 'draft-1', updated_at: NOW })
    expect(createDraft).toHaveBeenCalledOnce()
    expect(updateDraft).toHaveBeenCalledWith(expect.objectContaining({ id: 'draft-1' }), expect.anything())
    expect(sendDraft).toHaveBeenCalledWith('draft-1', expect.anything())
    expect(clean).toHaveBeenCalledWith('outbox-1')
  })

  it('loses a claim race without touching Gmail', async () => {
    const row = fakeRow()
    const store = new FakeOutboxDb(row)
    const createDraft = vi.fn(async () => 'draft-1')
    const sender = effectSender(store, effectProvider({ createDraft }), {
      beforeRemote: async () => {
        row.state = 'composing'
      }
    })

    await sender.trigger()

    expect(createDraft).not.toHaveBeenCalled()
    expect(row.state).toBe('composing')
  })

  it('recovers a durable draft by resending it and treats a missing draft as already sent', async () => {
    const presentStore = new FakeOutboxDb(fakeRow({ state: 'sending', gmail_draft_id: 'draft-1' }))
    const presentSend = vi.fn(async () => ({ id: 'sent-message', threadId: '' }))
    await effectSender(presentStore, effectProvider({ sendDraft: presentSend })).trigger()
    expect(presentSend).toHaveBeenCalledOnce()
    expect(presentStore.row().state).toBe('sent')

    const missingStore = new FakeOutboxDb(fakeRow({ state: 'sending', gmail_draft_id: 'draft-gone' }))
    const missingSend = vi.fn(async () => ({ id: 'sent-message', threadId: '' }))
    await effectSender(
      missingStore,
      effectProvider({
        getDraft: vi.fn(async () => {
          throw new GmailApiError(404, 'gone')
        }),
        sendDraft: missingSend
      })
    ).trigger()
    expect(missingSend).not.toHaveBeenCalled()
    expect(missingStore.row().state).toBe('sent')
  })

  it('bounds successful secondary negatives independently from transport retries', async () => {
    const checking = new FakeOutboxDb(fakeRow({ state: 'sending', attempts: 9 }))
    await effectSender(checking, effectProvider({ findByRfcId: vi.fn(async () => null) })).trigger()
    expect(checking.row()).toMatchObject({
      state: 'sending',
      attempts: 0,
      verify_attempts: 1,
      send_at: NOW + 10_000,
      last_error: null
    })

    const exhausted = new FakeOutboxDb(fakeRow({ state: 'sending', attempts: 9, verify_attempts: 5 }))
    const notify = vi.fn()
    await effectSender(exhausted, effectProvider({ findByRfcId: vi.fn(async () => null) }), {
      notify
    }).trigger()
    expect(exhausted.row()).toMatchObject({ state: 'needs-review', attempts: 0, verify_attempts: 6 })
    expect(exhausted.row().last_error).toContain("couldn't confirm")
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed', id: 'outbox-1' }))
  })

  it('adopts an orphaned draft before sending and never creates a replacement', async () => {
    const store = new FakeOutboxDb(fakeRow({ state: 'sending' }))
    const createDraft = vi.fn(async () => 'replacement')
    const sendDraft = vi.fn(async () => ({ id: 'sent-message', threadId: '' }))
    const remote = effectProvider({
      createDraft,
      sendDraft,
      findByRfcId: vi.fn(async () => ({
        kind: 'draft' as const,
        draftId: 'orphaned-draft',
        messageId: 'orphaned-message'
      }))
    })

    await effectSender(store, remote).trigger()

    expect(createDraft).not.toHaveBeenCalled()
    expect(sendDraft).toHaveBeenCalledWith('orphaned-draft', expect.anything())
    expect(store.row()).toMatchObject({ state: 'sent', gmail_draft_id: 'orphaned-draft' })
  })

  it('marks an authoritatively matched sent message without creating or sending a draft', async () => {
    const store = new FakeOutboxDb(fakeRow({ state: 'sending' }))
    const createDraft = vi.fn(async () => 'replacement')
    const sendDraft = vi.fn(async () => ({ id: 'duplicate', threadId: '' }))
    await effectSender(
      store,
      effectProvider({
        createDraft,
        sendDraft,
        findByRfcId: vi.fn(async () => ({ kind: 'message' as const, messageId: 'sent-message' }))
      })
    ).trigger()

    expect(store.row().state).toBe('sent')
    expect(createDraft).not.toHaveBeenCalled()
    expect(sendDraft).not.toHaveBeenCalled()
  })

  it('parks a draft that disappears before send instead of claiming success', async () => {
    const store = new FakeOutboxDb(fakeRow())
    const sendDraft = vi.fn(async () => ({ id: 'sent-message', threadId: '' }))
    await effectSender(
      store,
      effectProvider({
        updateDraft: vi.fn(async () => {
          throw new GmailApiError(404, 'draft disappeared')
        }),
        sendDraft
      })
    ).trigger()

    expect(sendDraft).not.toHaveBeenCalled()
    expect(store.row()).toMatchObject({ state: 'needs-review', gmail_draft_id: null })
    expect(store.row().last_error).toContain("couldn't confirm")
  })

  it('backs off ambiguous offline creates without making them undoable again', async () => {
    const store = new FakeOutboxDb(fakeRow())
    const sender = effectSender(
      store,
      effectProvider({
        createDraft: vi.fn(async () => {
          throw new TypeError('fetch failed')
        })
      })
    )

    await sender.trigger()

    expect(store.row()).toMatchObject({
      state: 'sending',
      attempts: 1,
      verify_attempts: 0,
      send_at: NOW + 5_000
    })
  })

  it('returns definitive quota rejections to queued and exposes permanent preflight failures', async () => {
    const quotaStore = new FakeOutboxDb(fakeRow())
    await effectSender(
      quotaStore,
      effectProvider({
        createDraft: vi.fn(async () => {
          throw new GmailApiError(429, 'quota', true)
        })
      })
    ).trigger()
    expect(quotaStore.row()).toMatchObject({ state: 'queued', attempts: 1, verify_attempts: 0 })

    const invalidStore = new FakeOutboxDb(fakeRow())
    const notify = vi.fn()
    await effectSender(
      invalidStore,
      effectProvider({
        createDraft: vi.fn(async () => {
          throw new GmailApiError(400, 'gmail /drafts failed (400): provider diagnostic blob')
        })
      }),
      { notify }
    ).trigger()
    expect(invalidStore.row()).toMatchObject({
      state: 'failed',
      last_error: 'gmail /drafts failed (400): provider diagnostic blob'
    })
    expect(notify).toHaveBeenCalledWith({
      kind: 'failed',
      id: 'outbox-1',
      error: 'Message could not be sent'
    })
  })

  it('arms elapsed queued work on boot and prunes expired sent rows', async () => {
    const due = fakeRow()
    const expired = fakeRow({
      id: 'expired',
      state: 'sent',
      updated_at: NOW - SENT_OUTBOX_RETENTION_MS - 1,
      send_at: null
    })
    const store = new FakeOutboxDb(due, expired)
    const time = new ManualTime()
    const sender = effectSender(store, effectProvider(), { time })

    sender.start()
    expect(store.rows.has('expired')).toBe(false)
    expect(time.nextDelay()).toBe(0)
    time.advance(0)
    await sender.trigger()
    expect(store.row().state).toBe('sent')
  })

  it('aborts a stalled Gmail request after the shutdown grace period and persists recovery state', async () => {
    const store = new FakeOutboxDb(fakeRow())
    const time = new ManualTime()
    let observedSignal: AbortSignal | undefined
    const createDraft = vi.fn(
      async (_draft: unknown, options?: { signal?: AbortSignal }) =>
        new Promise<string>((_resolve, reject) => {
          observedSignal = options?.signal
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
        })
    )
    const sender = effectSender(store, effectProvider({ createDraft }), { time })
    const running = sender.trigger()
    await vi.waitFor(() => expect(createDraft).toHaveBeenCalledOnce())

    const stopping = sender.stop()
    expect(time.nextDelay()).toBe(5_000)
    time.advance(5_000)
    await Promise.all([running, stopping])

    expect(observedSignal?.aborted).toBe(true)
    expect(store.row()).toMatchObject({ state: 'sending', attempts: 1, verify_attempts: 0 })
  })
})
