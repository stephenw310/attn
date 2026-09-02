import { describe, expect, it } from 'vitest'
import { type Db, openDatabase } from './db'
import {
  createFollowUpOnSent,
  evaluateThreadFollowUp,
  followUpRecoveryPending,
  liveFollowUpThreadIds,
  resolveFollowUpOrigins,
  setFollowUpRecoveryPending,
  settleFollowUpCandidates
} from './followUps'

const ACCOUNT = 'user@attn.test'
const THREAD = 't-1'

function store(): Db {
  const db = openDatabase(':memory:')
  db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, 0)').run(ACCOUNT, ACCOUNT)
  return db
}

interface MessagePatch {
  id: string
  internalDate: number | null
  labels?: string[]
  rfcMessageId?: string | null
  references?: string[]
}

function addMessage(db: Db, patch: MessagePatch, threadId = THREAD): void {
  db.prepare(
    `INSERT INTO messages (account_id, id, thread_id, internal_date, labels_json, rfc_message_id, references_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ACCOUNT,
    patch.id,
    threadId,
    patch.internalDate,
    JSON.stringify(patch.labels ?? []),
    patch.rfcMessageId ?? null,
    patch.references ? JSON.stringify(patch.references) : null
  )
}

function reminder(db: Db, threadId = THREAD): Record<string, unknown> | undefined {
  return db
    .prepare("SELECT * FROM reminders WHERE account_id = ? AND thread_id = ? AND kind = 'follow_up'")
    .get(ACCOUNT, threadId) as Record<string, unknown> | undefined
}

function addOutboxRow(db: Db, id: string, rfcMessageId: string, createdAt: number): void {
  db.prepare(
    `INSERT INTO outbox (id, account_id, state, rfc_message_id, created_at, updated_at)
     VALUES (?, ?, 'sent', ?, ?, ?)`
  ).run(id, ACCOUNT, rfcMessageId, createdAt, createdAt)
}

const sentInput = {
  threadId: THREAD,
  dueAt: 5_000,
  gmailMessageId: 'm-origin',
  rfcMessageId: '<origin@attn.test>',
  rowCreatedAt: 100
}

describe('createFollowUpOnSent', () => {
  it('creates a pending reminder with an unresolved origin', () => {
    const db = store()
    createFollowUpOnSent(db, ACCOUNT, sentInput)
    expect(reminder(db)).toMatchObject({
      state: 'pending',
      due_at: 5_000,
      origin_message_id: 'm-origin',
      origin_rfc_message_id: '<origin@attn.test>',
      origin_internal_date: null,
      origin_outbox_created_at: 100
    })
  })

  it('a later send with a new deadline replaces the thread follow-up', () => {
    const db = store()
    addOutboxRow(db, 'o-old', '<origin@attn.test>', 100)
    createFollowUpOnSent(db, ACCOUNT, sentInput)
    createFollowUpOnSent(db, ACCOUNT, {
      ...sentInput,
      dueAt: 9_000,
      gmailMessageId: 'm-newer',
      rfcMessageId: '<newer@attn.test>',
      rowCreatedAt: 200
    })
    expect(reminder(db)).toMatchObject({
      due_at: 9_000,
      origin_message_id: 'm-newer',
      origin_rfc_message_id: '<newer@attn.test>',
      origin_internal_date: null
    })
  })

  it("replaying an earlier send's completion never replaces a newer reminder", () => {
    const db = store()
    // The newer send's reminder stands; its outbox row still exists.
    addOutboxRow(db, 'o-new', '<newer@attn.test>', 200)
    createFollowUpOnSent(db, ACCOUNT, {
      ...sentInput,
      dueAt: 9_000,
      gmailMessageId: 'm-newer',
      rfcMessageId: '<newer@attn.test>',
      rowCreatedAt: 200
    })
    // The crash-recovered older send completes afterwards.
    createFollowUpOnSent(db, ACCOUNT, sentInput)
    expect(reminder(db)).toMatchObject({ due_at: 9_000, origin_message_id: 'm-newer' })
  })

  it('rejects an earlier recovered send after the newer sent row was pruned', () => {
    const db = store()
    createFollowUpOnSent(db, ACCOUNT, {
      ...sentInput,
      dueAt: 9_000,
      gmailMessageId: 'm-newer',
      rfcMessageId: '<newer@attn.test>',
      rowCreatedAt: 200
    })
    db.prepare(
      "UPDATE reminders SET state = 'done' WHERE account_id = ? AND thread_id = ? AND kind = 'follow_up'"
    ).run(ACCOUNT, THREAD)

    createFollowUpOnSent(db, ACCOUNT, sentInput)

    expect(reminder(db)).toMatchObject({
      due_at: 9_000,
      state: 'done',
      origin_message_id: 'm-newer',
      origin_outbox_created_at: 200
    })
  })

  it('re-completing the same send is idempotent', () => {
    const db = store()
    createFollowUpOnSent(db, ACCOUNT, sentInput)
    createFollowUpOnSent(db, ACCOUNT, sentInput)
    expect(reminder(db)).toMatchObject({ due_at: 5_000, origin_message_id: 'm-origin', state: 'pending' })
  })
})

describe('resolveFollowUpOrigins', () => {
  it('resolves from the store by Gmail id and evaluates cached replies immediately', () => {
    const db = store()
    createFollowUpOnSent(db, ACCOUNT, sentInput)
    addMessage(db, { id: 'm-origin', internalDate: 1_000, labels: ['SENT'] })
    // A reply cached before the origin resolved must cancel at resolution.
    addMessage(db, { id: 'm-reply', internalDate: 2_000 })
    expect(resolveFollowUpOrigins(db, ACCOUNT)).toEqual([THREAD])
    expect(reminder(db)).toMatchObject({ origin_internal_date: 1_000, state: 'canceled' })
  })

  it('resolves by RFC Message-ID when the provider returned no message id', () => {
    const db = store()
    createFollowUpOnSent(db, ACCOUNT, { ...sentInput, gmailMessageId: null })
    addMessage(db, {
      id: 'm-authoritative',
      internalDate: 1_000,
      labels: ['SENT'],
      rfcMessageId: '<origin@attn.test>'
    })
    resolveFollowUpOrigins(db, ACCOUNT)
    expect(reminder(db)).toMatchObject({
      origin_message_id: 'm-authoritative',
      origin_internal_date: 1_000,
      state: 'pending'
    })
  })

  it('leaves an unresolved origin untouched — never a guess', () => {
    const db = store()
    createFollowUpOnSent(db, ACCOUNT, sentInput)
    addMessage(db, { id: 'm-unrelated', internalDate: 9_999 })
    expect(resolveFollowUpOrigins(db, ACCOUNT)).toEqual([])
    expect(reminder(db)).toMatchObject({ origin_internal_date: null, state: 'pending' })
  })
})

describe('evaluateThreadFollowUp', () => {
  function resolved(db: Db): void {
    createFollowUpOnSent(db, ACCOUNT, sentInput)
    addMessage(db, {
      id: 'm-origin',
      internalDate: 1_000,
      labels: ['SENT'],
      rfcMessageId: '<origin@attn.test>'
    })
    resolveFollowUpOrigins(db, ACCOUNT)
  }

  it('the originating sent message and older messages never cancel', () => {
    const db = store()
    resolved(db)
    addMessage(db, { id: 'm-older', internalDate: 500 })
    expect(evaluateThreadFollowUp(db, ACCOUNT, THREAD)).toBe(false)
    expect(reminder(db)).toMatchObject({ state: 'pending' })
  })

  it('a DRAFT never cancels', () => {
    const db = store()
    resolved(db)
    addMessage(db, { id: 'm-draft', internalDate: 2_000, labels: ['DRAFT'] })
    expect(evaluateThreadFollowUp(db, ACCOUNT, THREAD)).toBe(false)
  })

  it('a later reply cancels a pending reminder; replay is idempotent', () => {
    const db = store()
    resolved(db)
    addMessage(db, { id: 'm-reply', internalDate: 2_000 })
    expect(evaluateThreadFollowUp(db, ACCOUNT, THREAD)).toBe(true)
    expect(reminder(db)).toMatchObject({ state: 'canceled' })
    expect(evaluateThreadFollowUp(db, ACCOUNT, THREAD)).toBe(false)
  })

  it("a later SENT message of the user's own cancels too", () => {
    const db = store()
    resolved(db)
    addMessage(db, { id: 'm-second-send', internalDate: 2_000, labels: ['SENT'] })
    expect(evaluateThreadFollowUp(db, ACCOUNT, THREAD)).toBe(true)
  })

  it('an equal-date message cancels only when its References name the origin', () => {
    const db = store()
    resolved(db)
    addMessage(db, { id: 'm-tie-unrelated', internalDate: 1_000 })
    expect(evaluateThreadFollowUp(db, ACCOUNT, THREAD)).toBe(false)
    addMessage(db, { id: 'm-tie-reply', internalDate: 1_000, references: ['<origin@attn.test>'] })
    expect(evaluateThreadFollowUp(db, ACCOUNT, THREAD)).toBe(true)
  })

  it('a returned reminder completes on a reply, keeping Inbox membership alone', () => {
    const db = store()
    resolved(db)
    db.prepare(
      "UPDATE reminders SET state = 'returned' WHERE account_id = ? AND thread_id = ? AND kind = 'follow_up'"
    ).run(ACCOUNT, THREAD)
    db.prepare('INSERT INTO thread_labels (account_id, thread_id, label_id) VALUES (?, ?, ?)').run(
      ACCOUNT,
      THREAD,
      'INBOX'
    )
    addMessage(db, { id: 'm-reply', internalDate: 2_000 })
    expect(evaluateThreadFollowUp(db, ACCOUNT, THREAD)).toBe(true)
    expect(reminder(db)).toMatchObject({ state: 'done' })
    expect(
      db
        .prepare("SELECT 1 FROM thread_labels WHERE account_id = ? AND thread_id = ? AND label_id = 'INBOX'")
        .get(ACCOUNT, THREAD)
    ).toBeDefined()
  })
})

describe('recovery guard and helpers', () => {
  it('persists per account and lists only live follow-ups', () => {
    const db = store()
    expect(followUpRecoveryPending(db, ACCOUNT)).toBe(false)
    setFollowUpRecoveryPending(db, ACCOUNT, true)
    expect(followUpRecoveryPending(db, ACCOUNT)).toBe(true)
    setFollowUpRecoveryPending(db, ACCOUNT, false)
    expect(followUpRecoveryPending(db, ACCOUNT)).toBe(false)

    createFollowUpOnSent(db, ACCOUNT, sentInput)
    createFollowUpOnSent(db, ACCOUNT, { ...sentInput, threadId: 't-2' })
    db.prepare(
      "UPDATE reminders SET state = 'canceled' WHERE account_id = ? AND thread_id = 't-2' AND kind = 'follow_up'"
    ).run(ACCOUNT)
    expect(liveFollowUpThreadIds(db, ACCOUNT)).toEqual([THREAD])
  })

  it('settleFollowUpCandidates resolves then evaluates in one pass', () => {
    const db = store()
    createFollowUpOnSent(db, ACCOUNT, sentInput)
    addMessage(db, { id: 'm-origin', internalDate: 1_000, labels: ['SENT'] })
    addMessage(db, { id: 'm-reply', internalDate: 2_000 })
    expect(settleFollowUpCandidates(db, ACCOUNT, ['m-does-not-matter'])).toBe(true)
    expect(reminder(db)).toMatchObject({ state: 'canceled' })
  })
})
