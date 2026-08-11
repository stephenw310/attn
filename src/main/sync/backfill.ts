// M0 backfill: labels + every INBOX thread (full content) into SQLite.
// Fails soft — any error surfaces through onError, never as an unhandled
// rejection. Widens to the 12-month metadata window at M1 (SPEC F2).

import type { Db } from '../db'
import { GmailApiError, type GmailClient } from '../gmail/client'
import { decodeBase64Url, findExternalTextParts, type GmailThread, textFromRaw } from '../gmail/parse'
import { persistThread } from './persist'

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

    db.prepare('INSERT OR IGNORE INTO accounts (id, email, created_at) VALUES (?, ?, ?)').run(
      accountId,
      profile.emailAddress,
      Date.now()
    )

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
    const upsertLabel = db.prepare(
      `INSERT INTO labels (account_id, id, name, type) VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id, id) DO UPDATE SET name = excluded.name, type = excluded.type`
    )
    for (const l of labelList.labels ?? []) upsertLabel.run(accountId, l.id, l.name, l.type)

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
 * For the rare messages whose extraction came up empty, fetch those parts and
 * fill in body_text. 404s are skipped — the snippet fallback still renders.
 */
async function fetchExternalBodies(
  db: Db,
  client: GmailClient,
  accountId: string,
  thread: GmailThread
): Promise<void> {
  const readBody = db.prepare('SELECT body_text FROM messages WHERE account_id = ? AND id = ?')
  const writeBody = db.prepare('UPDATE messages SET body_text = ? WHERE account_id = ? AND id = ?')

  for (const msg of thread.messages ?? []) {
    const row = readBody.get(accountId, msg.id) as { body_text: string | null } | undefined
    if (!row || (row.body_text ?? '') !== '') continue
    const parts = findExternalTextParts(msg.payload)
    const pick = parts.find((p) => p.mimeType === 'text/plain') ?? parts[0]
    if (!pick) continue
    try {
      const att = await client.get<{ data?: string }>(`/messages/${msg.id}/attachments/${pick.attachmentId}`)
      if (!att.data) continue
      const text = textFromRaw(pick.mimeType, decodeBase64Url(att.data))
      if (text) writeBody.run(text, accountId, msg.id)
    } catch (e) {
      if (e instanceof GmailApiError && e.status === 404) continue
      throw e
    }
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
