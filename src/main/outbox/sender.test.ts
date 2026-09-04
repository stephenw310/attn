import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { emptyDraftInput } from '../../shared/drafts'
import type { OutboxChanged, OutboxProgress } from '../../shared/outbox'
import { SENT_OUTBOX_RETENTION_MS } from '../../shared/outboxTuning'
import { type Db, openDatabase } from '../db'
import { getConversationForDisplay } from '../db/queries'
import { GmailApiError, GmailAuthError } from '../gmail/client'
import type { MailProvider } from '../sync/provider'
import { fakeMailProvider } from '../testing/fakes'
import type { SchedulerTime, TimerHandle } from '../time'
import { saveDraft } from './drafts'
import { OutboxSender } from './sender'

/** The shared fake plus the draft/send members the outbox protocol drives. */
function provider(overrides: Partial<MailProvider> = {}): MailProvider {
  return fakeMailProvider({
    getDraft: vi.fn(async (id) => ({ id, message: { id: `message-${id}`, threadId: 'thread-1' } })),
    saveDraft: vi.fn(async ({ id }) => id ?? 'created-draft'),
    createDraft: vi.fn(async () => 'created-draft'),
    updateDraft: vi.fn(async ({ id }) => id),
    sendDraft: vi.fn(async () => ({ id: 'sent-message', threadId: 'sent-thread' })),
    findByRfcId: vi.fn(),
    ...overrides
  })
}

type FakeSendState = 'composing' | 'queued' | 'sending' | 'sent' | 'failed' | 'needs-review'

interface FakeSendRow {
  id: string
  account_id: string
  state: FakeSendState
  kind: 'new'
  created_at: number
  follow_up_at: number | null
  gmail_draft_id: string | null
  gmail_message_id: string | null
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

const MACHINE_WRITE_PREFIX =
  'UPDATE outbox SET state = ?, gmail_draft_id = ?, send_at = ?, attempts = ?, verify_attempts = ?'

function fakeRow(patch: Partial<FakeSendRow> = {}): FakeSendRow {
  return {
    id: 'outbox-1',
    account_id: 'me@example.com',
    state: 'queued',
    kind: 'new',
    gmail_draft_id: null,
    gmail_message_id: null,
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
    created_at: NOW,
    updated_at: NOW,
    follow_up_at: null,
    send_at: NOW,
    attempts: 0,
    verify_attempts: 0,
    last_error: null,
    ...patch
  }
}

class FakeOutboxDb {
  readonly rows = new Map<string, FakeSendRow>()
  readonly db = {
    prepare: (sql: string) => this.prepare(sql),
    transaction: (fn: (...args: unknown[]) => unknown) => fn
  } as unknown as Db

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
        (candidate) =>
          candidate.account_id === accountId &&
          (candidate.state === 'sending' || (candidate.state === 'queued' && candidate.send_at !== null))
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
            ((candidate.state === 'sending' && (candidate.send_at === null || candidate.send_at <= now)) ||
              (candidate.state === 'queued' && candidate.send_at !== null && candidate.send_at <= now))
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
    // Every state change now arrives through persistPlan's one writer, so the
    // fake interprets that single shape instead of five hand-written updates.
    if (query.startsWith(MACHINE_WRITE_PREFIX)) return this.persistPlan(query, args)
    throw new Error(`unexpected fake run: ${query}`)
  }

  private persistPlan(query: string, args: unknown[]): { changes: number } {
    const columns = ['state', 'gmail_draft_id', 'send_at', 'attempts', 'verify_attempts']
    if (query.includes('rfc_message_id = ?')) columns.push('rfc_message_id')
    if (query.includes('gmail_message_id = COALESCE')) columns.push('gmail_message_id')
    if (query.includes('last_error = ?')) columns.push('last_error')
    if (query.includes('updated_at = ?')) columns.push('updated_at')
    const values = args.slice(0, columns.length)
    const guards = args.slice(columns.length)
    const row = this.rows.get(String(guards[1]))
    if (!row || row.account_id !== guards[0] || row.state !== guards[2]) return { changes: 0 }
    if (query.includes('gmail_draft_id IS NULL') && row.gmail_draft_id !== null) return { changes: 0 }
    // Mirrors the claim's own send time predicate, so a row the user undid
    // and re-sent during the mirror wait is no longer claimable.
    if (query.includes('send_at <= ?') && (row.send_at === null || row.send_at > Number(guards[3]))) {
      return { changes: 0 }
    }
    for (const [index, column] of columns.entries()) {
      const value = values[index]
      if (column === 'state') row.state = value as FakeSendState
      else if (column === 'gmail_draft_id') row.gmail_draft_id = value === null ? null : String(value)
      else if (column === 'send_at') row.send_at = value === null ? null : Number(value)
      else if (column === 'attempts') row.attempts = Number(value)
      else if (column === 'verify_attempts') row.verify_attempts = Number(value)
      else if (column === 'rfc_message_id') row.rfc_message_id = String(value)
      else if (column === 'gmail_message_id') {
        if (value !== null) row.gmail_message_id = String(value)
      } else if (column === 'last_error') row.last_error = value === null ? null : String(value)
      else if (column === 'updated_at') row.updated_at = Number(value)
    }
    return { changes: 1 }
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
    beforeRemote?: (signal?: AbortSignal) => Promise<void>
    clean?: (id: string) => void
    spoolRoot?: string | null
    progress?: (progress: OutboxProgress | null) => void
    mailChanged?: () => void
  } = {}
): OutboxSender {
  return new OutboxSender(
    store.db,
    () => 'me@example.com',
    () => remote,
    options.notify ?? vi.fn(),
    {
      beforeRemote: options.beforeRemote,
      time: options.time ?? new ManualTime(),
      spoolRoot: options.spoolRoot ?? null,
      cleanSpool: options.clean,
      progress: options.progress,
      mailChanged: options.mailChanged
    }
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

    expect(store.row()).toMatchObject({
      state: 'sent',
      gmail_draft_id: 'draft-1',
      gmail_message_id: 'sent-message',
      updated_at: NOW
    })
    expect(createDraft).toHaveBeenCalledOnce()
    expect(updateDraft).toHaveBeenCalledWith(expect.objectContaining({ id: 'draft-1' }), expect.anything())
    expect(sendDraft).toHaveBeenCalledWith('draft-1', expect.anything())
    expect(clean).toHaveBeenCalledWith('outbox-1')
  })

  it('sends from the cached send-as name without a Gmail round trip', async () => {
    const db = openDatabase(':memory:')
    try {
      db.prepare('INSERT INTO accounts (id, email) VALUES (?, ?)').run('me@example.com', 'me@example.com')
      db.prepare('INSERT INTO settings (account_id, key, value) VALUES (?, ?, ?)').run(
        'me@example.com',
        'sendAsDisplayName',
        'Chao Zhou'
      )
      const id = saveDraft(
        db,
        'me@example.com',
        {
          ...emptyDraftInput(),
          to: [{ name: '', email: 'you@example.com' }],
          subject: 'Cached identity',
          bodyHtml: '<p>Hi</p>',
          bodyText: 'Hi'
        },
        NOW
      )
      db.prepare("UPDATE outbox SET state = 'queued', rfc_message_id = ?, send_at = ? WHERE id = ?").run(
        '<cached@example.com>',
        NOW,
        id
      )
      const getSendAs = vi.fn()
      const createDraft = vi.fn(async ({ raw }: { raw: string }) => {
        expect(Buffer.from(raw, 'base64url').toString()).toContain('From: Chao Zhou <me@example.com>')
        return 'created-draft'
      })
      const sender = new OutboxSender(
        db,
        () => 'me@example.com',
        () => provider({ getSendAs, createDraft }),
        vi.fn(),
        { time: new ManualTime() }
      )

      await sender.trigger()

      expect(getSendAs).not.toHaveBeenCalled()
      expect(createDraft).toHaveBeenCalledTimes(1)
      expect(db.prepare('SELECT state FROM outbox WHERE id = ?').get(id)).toEqual({ state: 'sent' })
    } finally {
      db.close()
    }
  })

  it('invalidates mail after persisting the confirmed sent conversation', async () => {
    const db = openDatabase(':memory:')
    const mailChanged = vi.fn()
    try {
      db.prepare('INSERT INTO accounts (id, email) VALUES (?, ?)').run('me@example.com', 'me@example.com')
      db.prepare(
        `INSERT INTO messages
           (account_id, id, thread_id, from_name, from_email, internal_date, labels_json)
         VALUES (?, 'gmail-sent', 'identity-thread', 'Chao Zhou', ?, ?, '["SENT"]')`
      ).run('me@example.com', 'me@example.com', NOW - 1)
      // persistThread writes the thread's label union beside its messages.
      db.prepare(
        "INSERT INTO thread_labels (account_id, thread_id, label_id) VALUES (?, 'identity-thread', 'SENT')"
      ).run('me@example.com')
      const id = saveDraft(
        db,
        'me@example.com',
        {
          ...emptyDraftInput(),
          kind: 'reply',
          to: [{ name: '', email: 'you@example.com' }],
          subject: 'Re: Immediate refresh',
          bodyHtml: '<p>Fresh reply</p>',
          bodyText: 'Fresh reply',
          threadId: 'thread-1'
        },
        NOW
      )
      db.prepare("UPDATE outbox SET state = 'queued', rfc_message_id = ?, send_at = ? WHERE id = ?").run(
        '<fresh@example.com>',
        NOW,
        id
      )
      const getSendAs = vi.fn(async () => ({
        sendAsEmail: 'me@example.com',
        displayName: '',
        signature: '<div>Best, Chao</div>',
        isPrimary: true
      }))
      const createDraft = vi.fn(async ({ raw }: { raw: string }) => {
        expect(Buffer.from(raw, 'base64url').toString()).toContain('From: Chao Zhou <me@example.com>')
        return 'created-draft'
      })
      const remote = provider({
        getSendAs,
        createDraft,
        sendDraft: vi.fn(async () => ({ id: 'sent-message', threadId: 'thread-1' })),
        getThread: vi.fn(async () => ({
          id: 'thread-1',
          messages: [
            {
              id: 'sent-message',
              threadId: 'thread-1',
              labelIds: ['SENT'],
              snippet: 'Fresh reply',
              internalDate: String(NOW),
              payload: {
                mimeType: 'text/plain',
                headers: [
                  { name: 'From', value: 'me@example.com' },
                  { name: 'To', value: 'you@example.com' },
                  { name: 'Subject', value: 'Re: Immediate refresh' },
                  { name: 'Message-ID', value: '<gmail-rewritten@example.com>' }
                ],
                body: { data: Buffer.from('Fresh reply').toString('base64url') }
              }
            }
          ]
        }))
      })
      const sender = new OutboxSender(
        db,
        () => 'me@example.com',
        () => remote,
        vi.fn(),
        {
          time: new ManualTime(),
          mailChanged
        }
      )

      await sender.trigger()

      expect(db.prepare('SELECT state, gmail_message_id FROM outbox WHERE id = ?').get(id)).toEqual({
        state: 'sent',
        gmail_message_id: 'sent-message'
      })
      expect(getSendAs).toHaveBeenCalledWith('me@example.com', {
        signal: expect.any(AbortSignal),
        priority: 'send'
      })
      expect(
        db
          .prepare("SELECT value FROM settings WHERE account_id = ? AND key = 'sendAsDisplayName'")
          .get('me@example.com')
      ).toEqual({ value: 'Chao Zhou' })
      expect(
        db
          .prepare("SELECT value FROM settings WHERE account_id = ? AND key = 'sendAsSignatureHtml'")
          .get('me@example.com')
      ).toEqual({ value: expect.stringContaining('Best, Chao') })
      expect(db.prepare('SELECT body_text FROM messages WHERE id = ?').get('sent-message')).toEqual({
        body_text: 'Fresh reply'
      })
      expect(
        getConversationForDisplay(db, 'me@example.com', 'thread-1', 'unavailable')?.messages.map(
          (message) => message.id
        )
      ).toEqual(['sent-message'])
      expect(
        getConversationForDisplay(db, 'me@example.com', 'thread-1', 'unavailable')?.messages[0]
      ).toMatchObject({ fromName: 'Me', fromEmail: 'me@example.com' })
      expect(mailChanged).toHaveBeenCalledOnce()
    } finally {
      db.close()
    }
  })

  it('uploads attachment MIME once through the final update and reports per-file progress', async () => {
    const spoolRoot = await mkdtemp(join(tmpdir(), 'attn-sender-spool-'))
    const draftRoot = join(spoolRoot, 'outbox-1')
    const path = join(draftRoot, 'notes.txt')
    await mkdir(draftRoot)
    await writeFile(path, 'attachment bytes')
    const row = fakeRow({
      attachments_json: JSON.stringify([
        {
          id: 'attachment-1',
          filename: 'notes.txt',
          mimeType: 'text/plain',
          sizeBytes: 16,
          spoolPath: path
        }
      ])
    })
    const store = new FakeOutboxDb(row)
    let uploaded = ''
    const updateDraft = vi.fn(async (draft: Parameters<NonNullable<MailProvider['updateDraft']>>[0]) => {
      if (!draft.mime) throw new Error('missing MIME stream')
      const chunks: Buffer[] = []
      for await (const chunk of draft.mime.open()) chunks.push(Buffer.from(chunk))
      const body = Buffer.concat(chunks)
      expect(draft.mime.sizeBytes).toBe(body.byteLength)
      uploaded = body.toString()
      return draft.id
    })
    const progress = vi.fn<(value: OutboxProgress | null) => void>()
    const createDraft = vi.fn(async ({ raw }: { raw: string }) => {
      expect(Buffer.from(raw, 'base64url').toString()).not.toContain('notes.txt')
      return 'draft-1'
    })

    try {
      await effectSender(store, effectProvider({ createDraft, updateDraft }), {
        spoolRoot,
        progress
      }).trigger()
    } finally {
      await rm(spoolRoot, { recursive: true, force: true })
    }

    expect(createDraft).toHaveBeenCalledOnce()
    expect(updateDraft).toHaveBeenCalledOnce()
    expect(uploaded).toContain('Content-Disposition: attachment; filename="notes.txt"')
    expect(uploaded).toContain(Buffer.from('attachment bytes').toString('base64'))
    const updates = progress.mock.calls.flatMap(([value]) => (value ? [value] : []))
    expect(updates.map((value) => value.completedAttachments)).toEqual([0, 1])
    expect(updates.at(-1)).toMatchObject({ completedBytes: 16, totalBytes: 16 })
    expect(progress.mock.lastCall?.[0]).toBeNull()
  })

  it('clears attachment progress when an upload is deferred for retry', async () => {
    const spoolRoot = await mkdtemp(join(tmpdir(), 'attn-sender-spool-'))
    const draftRoot = join(spoolRoot, 'outbox-1')
    const path = join(draftRoot, 'notes.txt')
    await mkdir(draftRoot)
    await writeFile(path, 'data')
    const store = new FakeOutboxDb(
      fakeRow({
        gmail_draft_id: 'draft-1',
        attachments_json: JSON.stringify([
          {
            id: 'attachment-1',
            filename: 'notes.txt',
            mimeType: 'text/plain',
            sizeBytes: 4,
            spoolPath: path
          }
        ])
      })
    )
    const progress = vi.fn<(value: OutboxProgress | null) => void>()
    const updateDraft = vi.fn(async (draft: Parameters<NonNullable<MailProvider['updateDraft']>>[0]) => {
      if (!draft.mime) throw new Error('missing MIME stream')
      for await (const _chunk of draft.mime.open()) {
        // Consume the upload before simulating Gmail's retryable response.
      }
      throw new GmailApiError(503, 'unavailable', true)
    })

    try {
      await effectSender(store, effectProvider({ updateDraft }), { spoolRoot, progress }).trigger()
    } finally {
      await rm(spoolRoot, { recursive: true, force: true })
    }

    expect(store.row()).toMatchObject({ state: 'sending' })
    expect(store.row().send_at).toBeGreaterThan(NOW)
    expect(progress.mock.calls.some(([value]) => value !== null)).toBe(true)
    expect(progress.mock.lastCall?.[0]).toBeNull()
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
        findByRfcId: vi.fn(async () => ({ kind: 'message' as const, messageId: 'confirmed-message' })),
        sendDraft: missingSend
      })
    ).trigger()
    expect(missingSend).not.toHaveBeenCalled()
    expect(missingStore.row()).toMatchObject({ state: 'sent', gmail_message_id: 'confirmed-message' })
  })

  it('parks a draft deleted elsewhere during recovery instead of reporting it sent', async () => {
    // "Consumed" conflates "Gmail sent it" with "deleted from Drafts on another
    // device", and only the Message-ID lookup can tell them apart.
    const store = new FakeOutboxDb(fakeRow({ state: 'sending', gmail_draft_id: 'draft-deleted' }))
    const findByRfcId = vi.fn(async () => null)
    const sendDraft = vi.fn(async () => ({ id: 'sent-message', threadId: '' }))
    const notify = vi.fn()
    await effectSender(
      store,
      effectProvider({
        getDraft: vi.fn(async () => {
          throw new GmailApiError(404, 'deleted on another device')
        }),
        findByRfcId,
        sendDraft
      }),
      { notify }
    ).trigger()

    expect(findByRfcId).toHaveBeenCalledWith('<message@example.com>', expect.anything())
    expect(sendDraft).not.toHaveBeenCalled()
    expect(store.row()).toMatchObject({ state: 'needs-review', gmail_draft_id: null })
    expect(store.row().last_error).toContain("couldn't confirm")
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'failed', id: 'outbox-1' }))
  })

  it('keeps the full undo window when the user re-sends during the mirror checkpoint wait', async () => {
    const store = new FakeOutboxDb(fakeRow())
    const createDraft = vi.fn(async () => 'draft-1')
    const sender = effectSender(store, effectProvider({ createDraft }), {
      // Undo followed by a fresh send while the checkpoint wait holds the
      // drain: the row is queued again, with a send time that has not arrived.
      beforeRemote: async () => {
        store.row().send_at = NOW + 30_000
      }
    })

    await sender.trigger()

    expect(createDraft).not.toHaveBeenCalled()
    expect(store.row()).toMatchObject({ state: 'queued', send_at: NOW + 30_000 })
  })

  it('verifies an ambiguous 408 create by Message-ID instead of failing the row', async () => {
    const store = new FakeOutboxDb(fakeRow())
    const time = new ManualTime()
    const findByRfcId = vi.fn(async () => null)
    const sender = effectSender(
      store,
      effectProvider({
        createDraft: vi.fn(async () => {
          throw new GmailApiError(408, 'deadline exceeded')
        }),
        findByRfcId
      }),
      { time }
    )

    await sender.trigger()

    expect(store.row()).toMatchObject({ state: 'sending', attempts: 1, verify_attempts: 0 })
    expect(store.row().send_at).toBeGreaterThan(NOW)

    time.advance((store.row().send_at ?? NOW) - NOW)
    await sender.trigger()

    expect(findByRfcId).toHaveBeenCalledWith('<message@example.com>', expect.anything())
    expect(store.row()).toMatchObject({ state: 'sending', verify_attempts: 1 })
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

    expect(store.row()).toMatchObject({ state: 'sent', gmail_message_id: 'sent-message' })
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
      last_error: 'Gmail rejected this message — check its recipients and attachments'
    })
    expect(invalidStore.row()?.last_error).not.toContain('provider diagnostic blob')
    expect(notify).toHaveBeenCalledWith({
      kind: 'failed',
      id: 'outbox-1',
      error: 'Gmail rejected this message — check its recipients and attachments'
    })
  })

  it('retries a stale remote attachment locator so draft sync can refresh it', async () => {
    const getAttachmentData = vi.fn(async () => undefined)
    const createDraft = vi.fn(async () => 'draft-1')
    const store = new FakeOutboxDb(
      fakeRow({
        attachments_json: JSON.stringify([
          {
            id: 'remote-attachment',
            filename: 'report.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 12,
            spoolPath: '',
            remoteMessageId: 'stale-message',
            remoteAttachmentId: 'stale-locator'
          }
        ])
      })
    )

    await effectSender(store, effectProvider({ createDraft, getAttachmentData })).trigger()

    expect(getAttachmentData).toHaveBeenCalledWith(
      'stale-message',
      'stale-locator',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(createDraft).not.toHaveBeenCalled()
    expect(store.row()).toMatchObject({
      state: 'queued',
      attempts: 1,
      send_at: NOW + 5_000,
      last_error: 'An attachment is temporarily unavailable — Attn will retry'
    })
  })

  it('fails a message whose attachment source never recovers instead of retrying forever', async () => {
    const getAttachmentData = vi.fn(async () => undefined)
    const createDraft = vi.fn(async () => 'draft-1')
    const notify = vi.fn()
    const store = new FakeOutboxDb(
      fakeRow({
        // One short of the ladder's limit, so this attempt is the last one.
        attempts: 7,
        attachments_json: JSON.stringify([
          {
            id: 'remote-attachment',
            filename: 'report.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 12,
            spoolPath: '',
            remoteMessageId: 'stale-message',
            remoteAttachmentId: 'stale-locator'
          }
        ])
      })
    )

    await effectSender(store, effectProvider({ createDraft, getAttachmentData }), { notify }).trigger()

    expect(createDraft).not.toHaveBeenCalled()
    expect(store.row()).toMatchObject({ state: 'failed', attempts: 8, send_at: null })
    expect(notify).toHaveBeenCalledWith({
      kind: 'failed',
      id: 'outbox-1',
      error: 'An attachment is still unavailable — reopen the message and attach it again'
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

  it('prunes sent follow-up origins after their creation order is persisted on the reminder', async () => {
    const db = openDatabase(':memory:')
    try {
      db.prepare('INSERT INTO accounts (id, email) VALUES (?, ?)').run('me@example.com', 'me@example.com')
      const insert = db.prepare(
        `INSERT INTO outbox (id, account_id, state, thread_id, rfc_message_id, created_at, updated_at)
         VALUES (?, 'me@example.com', 'sent', 't-1', ?, ?, ?)`
      )
      const expired = NOW - SENT_OUTBOX_RETENTION_MS - 1
      insert.run('origin-newer', '<newer@x>', 200, expired)
      insert.run('unreferenced', '<other@x>', 100, expired)
      db.prepare(
        `INSERT INTO reminders (account_id, thread_id, kind, due_at, state,
           origin_rfc_message_id, origin_outbox_created_at)
         VALUES ('me@example.com', 't-1', 'follow_up', ?, 'pending', '<newer@x>', 200)`
      ).run(NOW + 60_000)
      const time = new ManualTime()
      const sender = new OutboxSender(
        db,
        () => 'me@example.com',
        () => effectProvider(),
        vi.fn(),
        { time }
      )

      sender.start()
      const remaining = (): string[] =>
        (db.prepare('SELECT id FROM outbox ORDER BY id').all() as Array<{ id: string }>).map((row) => row.id)
      expect(remaining()).toEqual([])
    } finally {
      db.close()
    }
  })

  it('does not spin on a malformed queued row without a send time', async () => {
    const store = new FakeOutboxDb(fakeRow({ send_at: null }))
    const time = new ManualTime()
    const sender = effectSender(store, effectProvider(), { time })

    sender.start()
    expect(time.nextDelay()).toBeUndefined()
    await sender.trigger()
    expect(store.row().state).toBe('queued')
    expect(time.nextDelay()).toBeUndefined()
  })

  it('contains top-level drain failures and retries them with backoff', async () => {
    const time = new ManualTime()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const brokenDb = {
      prepare: vi.fn(() => ({
        get: vi.fn(() => {
          throw new Error('database unavailable')
        })
      }))
    } as unknown as Db
    const sender = new OutboxSender(
      brokenDb,
      () => 'me@example.com',
      () => effectProvider(),
      vi.fn(),
      { time }
    )

    await expect(sender.trigger()).resolves.toBeUndefined()
    expect(error).toHaveBeenCalledWith('[outbox] drain failed: database unavailable')
    expect(time.nextDelay()).toBe(5_000)
    error.mockRestore()
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
    expect(store.row()).toMatchObject({ state: 'sending', attempts: 0, verify_attempts: 0, last_error: null })
  })

  it('applies the shutdown grace period while waiting for an active mirror checkpoint', async () => {
    const store = new FakeOutboxDb(fakeRow())
    const time = new ManualTime()
    let observedSignal: AbortSignal | undefined
    const beforeRemote = vi.fn(
      async (signal?: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          observedSignal = signal
          signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
        })
    )
    const sender = effectSender(store, effectProvider(), { time, beforeRemote })
    const running = sender.trigger()
    await vi.waitFor(() => expect(beforeRemote).toHaveBeenCalledOnce())

    const stopping = sender.stop()
    expect(time.nextDelay()).toBe(5_000)
    time.advance(5_000)
    await Promise.all([running, stopping])

    expect(observedSignal?.aborted).toBe(true)
    expect(store.row()).toMatchObject({ state: 'queued', attempts: 0, last_error: null })
  })

  it('stores and broadcasts a stable user-facing error instead of Gmail response text', async () => {
    const store = new FakeOutboxDb(fakeRow())
    const notify = vi.fn()
    const createDraft = vi.fn(async () => {
      throw new GmailApiError(400, 'gmail /drafts failed (400): {"error":{"private":"details"}}')
    })
    const sender = effectSender(store, effectProvider({ createDraft }), { notify })

    await sender.trigger()

    expect(store.row()).toMatchObject({
      state: 'failed',
      last_error: 'Gmail rejected this message — check its recipients and attachments'
    })
    expect(notify).toHaveBeenLastCalledWith({
      kind: 'failed',
      id: 'outbox-1',
      error: 'Gmail rejected this message — check its recipients and attachments'
    })
  })

  it('keeps a send whose token refresh failed queued, named, and resumable after reconnect', async () => {
    const store = new FakeOutboxDb(fakeRow())
    const time = new ManualTime()
    // A revoked refresh token fails at the token endpoint before the request is
    // issued, so no draft can exist. Before this was classified, the row went to
    // Message-ID verification and — after the user reconnected — six negative
    // searches parked a never-sent message in needs-review.
    let authorized = false
    const createDraft = vi.fn(async () => {
      if (!authorized) throw new GmailAuthError('token refresh failed (400): invalid_grant')
      return 'created-draft'
    })
    const findByRfcId = vi.fn()
    const remote = effectProvider({ createDraft, findByRfcId })
    const sender = effectSender(store, remote, { time })

    await sender.trigger()

    // Nothing reached Gmail: the row is back in `queued` (still undoable), the
    // reason the user reads is the authorization, and a retry is armed.
    expect(store.row()).toMatchObject({
      state: 'queued',
      attempts: 1,
      verify_attempts: 0,
      last_error: 'Gmail authorization expired — sign in again and retry'
    })
    expect(createDraft).toHaveBeenCalledTimes(1)
    expect(findByRfcId).not.toHaveBeenCalled()

    // Reconnect (resumeOnlineWork triggers the sender) → it simply sends.
    authorized = true
    time.advance(5_000)
    await sender.trigger()
    expect(store.row()).toMatchObject({ state: 'sent', gmail_draft_id: 'created-draft' })
    expect(findByRfcId).not.toHaveBeenCalled()
  })
})
