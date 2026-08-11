// M0 backfill: labels + every INBOX thread (full content) into SQLite.
// Fails soft — any error surfaces through onError, never as an unhandled
// rejection. Widens to the 12-month metadata window at M1 (SPEC F2).

import type { Db } from '../db'
import { GmailApiError, type GmailClient } from '../gmail/client'
import {
  decodeBase64Url,
  extractBodyHtml,
  extractBodyText,
  findExternalTextParts,
  type GmailThread,
  hasInlinePlainText
} from '../gmail/parse'
import { mergeExternalBodies } from './mergeBodies'
import { ensureAccount, persistThread, upsertLabels } from './persist'

interface Profile {
  emailAddress: string
  historyId: string
}

interface LabelList {
  labels?: { id: string; name: string; type: string }[]
}

interface ThreadList {
  threads?: { id: string }[]
  nextPageToken?: string
}

export interface BackfillCallbacks {
  onProgress: (threadsDone: number) => void
  onDone: (accountId: string, threadCount: number) => void
  onError: (message: string) => void
}

// M0 bounds: newest N threads only, and don't repeat a fresh successful run.
// M1 replaces both with the spec'd windowed backfill + incremental history sync.
const MAX_THREADS_PER_RUN = 1000
const FRESH_SYNC_WINDOW_MS = 15 * 60 * 1000

export async function runInboxBackfill(db: Db, client: GmailClient, cb: BackfillCallbacks): Promise<void> {
  try {
    const profile = await client.get<Profile>('/profile')
    const accountId = profile.emailAddress

    ensureAccount(db, accountId, profile.emailAddress)

    // backfill_cursor === 'done' marks a COMPLETED run; updated_at is its
    // finish time. Skip if we completed one recently (dev restarts are common).
    const prev = db
      .prepare('SELECT backfill_cursor, updated_at FROM sync_state WHERE account_id = ?')
      .get(accountId) as { backfill_cursor: string | null; updated_at: number | null } | undefined
    if (prev?.backfill_cursor === 'done' && Date.now() - (prev.updated_at ?? 0) < FRESH_SYNC_WINDOW_MS) {
      console.log('[sync] recent completed backfill exists — skipping (M0)')
      cb.onDone(accountId, 0)
      return
    }

    // Checkpoint BEFORE backfill: anything that changes while we backfill is
    // replayed by incremental history sync from this id (gapless, M1).
    // updated_at is only stamped on successful completion.
    db.prepare(
      `INSERT INTO sync_state (account_id, last_history_id, backfill_cursor, updated_at) VALUES (?, ?, NULL, 0)
       ON CONFLICT(account_id) DO UPDATE SET last_history_id = excluded.last_history_id`
    ).run(accountId, profile.historyId)

    const labelList = await client.get<LabelList>('/labels')
    upsertLabels(db, accountId, labelList.labels ?? [])

    let done = 0
    let pageToken: string | undefined
    do {
      const params: Record<string, string> = { labelIds: 'INBOX', maxResults: '100' }
      if (pageToken) params.pageToken = pageToken
      const page = await client.get<ThreadList>('/threads', params)

      await mapConcurrent(page.threads ?? [], 3, async (t) => {
        let full: GmailThread
        try {
          full = await client.get<GmailThread>(`/threads/${t.id}`, { format: 'full' })
        } catch (e) {
          // Normal race on an active inbox: listed thread archived/deleted
          // before we fetched it. Skip it, keep the backfill alive.
          if (e instanceof GmailApiError && e.status === 404) {
            console.log(`[sync] thread ${t.id} vanished mid-backfill — skipped`)
            return
          }
          throw e
        }
        persistThread(db, accountId, full)
        await fetchExternalBodies(db, client, accountId, full)
        done++
      })

      cb.onProgress(done)
      pageToken = page.nextPageToken
      if (done >= MAX_THREADS_PER_RUN && pageToken) {
        console.log(`[sync] M0 cap reached (${MAX_THREADS_PER_RUN} threads) — older mail deferred to M1`)
        pageToken = undefined
      }
    } while (pageToken)

    db.prepare('UPDATE sync_state SET backfill_cursor = ?, updated_at = ? WHERE account_id = ?').run(
      'done',
      Date.now(),
      accountId
    )
    cb.onDone(accountId, done)
  } catch (e) {
    cb.onError(e instanceof Error ? e.message : String(e))
  }
}

/**
 * Gmail externalizes large text bodies as attachment parts (no inline data).
 * Fetch out-of-line text parts and fill both body formats. 404s are skipped —
 * the snippet fallback still renders.
 */
async function fetchExternalBodies(
  db: Db,
  client: GmailClient,
  accountId: string,
  thread: GmailThread
): Promise<void> {
  const readBody = db.prepare('SELECT body_text, body_html FROM messages WHERE account_id = ? AND id = ?')
  const writeBody = db.prepare(
    'UPDATE messages SET body_text = ?, body_html = ? WHERE account_id = ? AND id = ?'
  )

  for (const msg of thread.messages ?? []) {
    const row = readBody.get(accountId, msg.id) as
      | { body_text: string | null; body_html: string | null }
      | undefined
    if (!row) continue
    const parts = findExternalTextParts(msg.payload)
    if (parts.length === 0) continue

    const inlineText = extractBodyText(msg.payload)
    const inlineHtml = extractBodyHtml(msg.payload)
    const plainComplete = Boolean(row.body_text) && row.body_text !== inlineText
    const htmlComplete = Boolean(row.body_html) && row.body_html !== inlineHtml
    const plains: string[] = []
    const htmls: string[] = []
    for (const part of parts) {
      if (part.mimeType === 'text/plain' && plainComplete) continue
      if (part.mimeType === 'text/html' && htmlComplete) continue
      try {
        const att = await client.get<{ data?: string }>(
          `/messages/${msg.id}/attachments/${part.attachmentId}`
        )
        if (!att.data) continue
        const raw = decodeBase64Url(att.data)
        if (!raw) continue
        if (part.mimeType === 'text/html') htmls.push(raw)
        else plains.push(raw)
      } catch (e) {
        if (e instanceof GmailApiError && e.status === 404) continue
        throw e
      }
    }

    if (plains.length === 0 && htmls.length === 0) continue

    const { bodyText, bodyHtml } = mergeExternalBodies({
      storedText: row.body_text,
      storedHtml: row.body_html,
      inlineText,
      hasInlinePlain: hasInlinePlainText(msg.payload),
      fetchedPlain: plains,
      fetchedHtml: htmls
    })
    if (bodyText === row.body_text && bodyHtml === row.body_html) continue
    writeBody.run(bodyText, bodyHtml, accountId, msg.id)
  }
}

async function mapConcurrent<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items]
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    for (;;) {
      const item = queue.shift()
      if (item === undefined) return
      await fn(item)
    }
  })
  await Promise.all(workers)
}
