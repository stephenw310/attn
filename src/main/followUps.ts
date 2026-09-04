// Follow-up reminders (T35, SPEC F9): "remind me if no reply". The deadline
// rides the outbox row from compose; the reminder row is created only when
// the send commits, keyed to the sent message's identity so a canceling reply
// must postdate it. Everything here works against the local store — origin
// resolution and reply comparison read cached messages, never Gmail.

import type { Db } from './db'
import { deleteAccountSetting, readAccountSetting, writeAccountSetting } from './settings'
import { settleReminders } from './store/reminders'

export const FOLLOW_UP_KIND = 'follow_up'

/**
 * Recovery guard (F9): while set, no follow-up may return — history expired
 * and a reply may exist that only an authoritative thread snapshot can show.
 * Stored per account in settings so it survives restart mid-recovery.
 */
const FOLLOW_UP_RECOVERY_SETTING = 'followUpRecoveryPending'

export function followUpRecoveryPending(db: Db, accountId: string): boolean {
  return readAccountSetting(db, accountId, FOLLOW_UP_RECOVERY_SETTING) === '1'
}

export function setFollowUpRecoveryPending(db: Db, accountId: string, pending: boolean): void {
  if (pending) writeAccountSetting(db, accountId, FOLLOW_UP_RECOVERY_SETTING, '1')
  else deleteAccountSetting(db, accountId, FOLLOW_UP_RECOVERY_SETTING)
}

export interface SentFollowUpInput {
  threadId: string
  dueAt: number
  /** The provider's final message id when the send protocol returned one. */
  gmailMessageId: string | null
  /** The locally minted RFC Message-ID; stable across retries. */
  rfcMessageId: string
  /** The outbox row's creation time, ordering competing sends on one thread. */
  rowCreatedAt: number
}

/**
 * Create (or replace) the thread's follow-up at the sent transition. Runs
 * inside the caller's sent-commit transaction so an undone or failed send can
 * never leave a live reminder behind. A replayed completion of an *earlier*
 * send must not replace a newer send's reminder: same-origin writes are
 * idempotent, and a different origin loses only when its own outbox row is
 * provably newer (creation time — never send-completion time, which moves on
 * retry, and never opaque Gmail id ordering).
 */
export function createFollowUpOnSent(db: Db, accountId: string, input: SentFollowUpInput): void {
  const existing = db
    .prepare(
      `SELECT origin_rfc_message_id AS originRfc,
              origin_outbox_created_at AS originOutboxCreatedAt
       FROM reminders
       WHERE account_id = ? AND thread_id = ? AND kind = '${FOLLOW_UP_KIND}'`
    )
    .get(accountId, input.threadId) as
    | { originRfc: string | null; originOutboxCreatedAt: number | null }
    | undefined
  if (existing && existing.originRfc !== null && existing.originRfc !== input.rfcMessageId) {
    const retained =
      existing.originOutboxCreatedAt ??
      (
        db
          .prepare('SELECT created_at AS createdAt FROM outbox WHERE account_id = ? AND rfc_message_id = ?')
          .get(accountId, existing.originRfc) as { createdAt: number } | undefined
      )?.createdAt
    if (retained !== undefined && retained > input.rowCreatedAt) return
  }
  db.prepare(
    `INSERT INTO reminders (account_id, thread_id, kind, due_at, state,
       origin_message_id, origin_rfc_message_id, origin_internal_date, origin_outbox_created_at)
     VALUES (?, ?, '${FOLLOW_UP_KIND}', ?, 'pending', ?, ?, NULL, ?)
     ON CONFLICT(account_id, thread_id, kind) DO UPDATE SET
       due_at = excluded.due_at, state = 'pending',
       origin_message_id = excluded.origin_message_id,
       origin_rfc_message_id = excluded.origin_rfc_message_id,
       origin_internal_date = NULL,
       origin_outbox_created_at = excluded.origin_outbox_created_at`
  ).run(accountId, input.threadId, input.dueAt, input.gmailMessageId, input.rfcMessageId, input.rowCreatedAt)
}

interface FollowUpRow {
  thread_id: string
  due_at: number
  state: string
  origin_message_id: string | null
  origin_rfc_message_id: string | null
  origin_internal_date: number | null
}

interface StoredMessage {
  id: string
  internal_date: number | null
  labels_json: string | null
  references_json: string | null
  rfc_message_id: string | null
}

function messageIsDraft(message: StoredMessage): boolean {
  if (message.labels_json === null) return false
  try {
    return (JSON.parse(message.labels_json) as string[]).includes('DRAFT')
  } catch {
    return false
  }
}

function referencesOrigin(message: StoredMessage, originRfcId: string | null): boolean {
  if (originRfcId === null || message.references_json === null) return false
  try {
    return (JSON.parse(message.references_json) as string[]).includes(originRfcId)
  } catch {
    return false
  }
}

/**
 * Does this cached message cancel the reminder? The originating sent message
 * never does. A distinct non-draft message qualifies when its internalDate is
 * later; on an exact tie, only a References chain naming the origin breaks it.
 * Opaque Gmail ids are never ordered (F9).
 */
function qualifiesAsReply(message: StoredMessage, reminder: FollowUpRow): boolean {
  if (reminder.origin_internal_date === null) return false
  if (message.id === reminder.origin_message_id) return false
  if (
    reminder.origin_rfc_message_id !== null &&
    message.rfc_message_id !== null &&
    message.rfc_message_id === reminder.origin_rfc_message_id
  ) {
    return false
  }
  if (messageIsDraft(message)) return false
  if (message.internal_date === null) return false
  if (message.internal_date > reminder.origin_internal_date) return true
  return (
    message.internal_date === reminder.origin_internal_date &&
    referencesOrigin(message, reminder.origin_rfc_message_id)
  )
}

/**
 * Compare the thread's cached non-draft messages against a live follow-up and
 * settle it when a qualifying reply exists: a pending reminder cancels, a
 * returned one completes — its chip and priority clear, its Inbox membership
 * (the reply's own doing) stays. Returns true when anything changed.
 */
export function evaluateThreadFollowUp(db: Db, accountId: string, threadId: string): boolean {
  const reminder = db
    .prepare(
      `SELECT thread_id, due_at, state, origin_message_id, origin_rfc_message_id, origin_internal_date
       FROM reminders WHERE account_id = ? AND thread_id = ? AND kind = '${FOLLOW_UP_KIND}'
         AND state IN ('pending', 'returned')`
    )
    .get(accountId, threadId) as FollowUpRow | undefined
  if (!reminder || reminder.origin_internal_date === null) return false
  const messages = db
    .prepare(
      `SELECT id, internal_date, labels_json, references_json, rfc_message_id
       FROM messages WHERE account_id = ? AND thread_id = ?`
    )
    .all(accountId, threadId) as StoredMessage[]
  if (!messages.some((message) => qualifiesAsReply(message, reminder))) return false
  settleReminders(db, accountId, threadId, FOLLOW_UP_KIND)
  return true
}

/**
 * Resolve unresolved origins from the store. The post-send read usually does
 * this at the sent transition; when it failed, the owning account's ordinary
 * sync session retries here — history refetches the thread after the SENT
 * message lands, so resolution needs no network of its own. A resolved
 * reminder immediately evaluates already-cached replies, including one that
 * was fetched before the sent transition committed. Returns the thread ids
 * whose reminders changed (resolved or settled).
 */
export function resolveFollowUpOrigins(db: Db, accountId: string): string[] {
  const unresolved = db
    .prepare(
      `SELECT thread_id, due_at, state, origin_message_id, origin_rfc_message_id, origin_internal_date
       FROM reminders WHERE account_id = ? AND kind = '${FOLLOW_UP_KIND}'
         AND state IN ('pending', 'returned') AND origin_internal_date IS NULL`
    )
    .all(accountId) as FollowUpRow[]
  const changed: string[] = []
  for (const reminder of unresolved) {
    const origin = (db
      .prepare(
        `SELECT id, internal_date, rfc_message_id FROM messages
         WHERE account_id = ? AND thread_id = ? AND (id = ? OR rfc_message_id = ?)
         LIMIT 1`
      )
      .get(
        accountId,
        reminder.thread_id,
        reminder.origin_message_id ?? '',
        reminder.origin_rfc_message_id ?? ''
      ) ?? null) as { id: string; internal_date: number | null; rfc_message_id: string | null } | null
    if (origin === null || origin.internal_date === null) continue
    db.prepare(
      `UPDATE reminders SET origin_message_id = ?, origin_rfc_message_id = COALESCE(?, origin_rfc_message_id),
         origin_internal_date = ?
       WHERE account_id = ? AND thread_id = ? AND kind = '${FOLLOW_UP_KIND}'`
    ).run(origin.id, origin.rfc_message_id, origin.internal_date, accountId, reminder.thread_id)
    changed.push(reminder.thread_id)
    evaluateThreadFollowUp(db, accountId, reminder.thread_id)
  }
  return changed
}

/**
 * The poller-cycle settle (T35), shared with the e2e history seam so both run
 * the identical production sequence: resolve unresolved origins from the
 * refetched store, then evaluate each candidate thread's follow-up.
 */
export function settleFollowUpCandidates(
  db: Db,
  accountId: string,
  candidateThreadIds: Iterable<string>
): boolean {
  let changed = resolveFollowUpOrigins(db, accountId).length > 0
  for (const threadId of new Set(candidateThreadIds)) {
    if (evaluateThreadFollowUp(db, accountId, threadId)) changed = true
  }
  return changed
}

/** Threads whose live follow-ups history-expiry recovery must re-check (F9). */
export function liveFollowUpThreadIds(db: Db, accountId: string): string[] {
  const rows = db
    .prepare(
      `SELECT thread_id FROM reminders
       WHERE account_id = ? AND kind = '${FOLLOW_UP_KIND}' AND state IN ('pending', 'returned')`
    )
    .all(accountId) as { thread_id: string }[]
  return rows.map((row) => row.thread_id)
}
