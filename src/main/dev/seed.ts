import { readFileSync } from 'node:fs'
import type { Db } from '../db'
import type { GmailPart, GmailThread } from '../gmail/parse'
import { ensureSplitSetup } from '../splits'
import { ensureAccount, type LabelRow, persistThread, upsertLabels } from '../sync/persist'

interface SeedMessage {
  id: string
  labelIds?: string[]
  /** Absolute epoch ms. Mutually exclusive with `receivedDaysAgo`. */
  internalDate?: string
  /**
   * Day-anchored age: 0 is today, 1 yesterday, and so on. Resolved against local
   * midnight rather than the clock, so a fixture lands in the same date group no
   * matter what time of day the suite runs. Prefer this over `internalDate` —
   * absolute stamps age into "Older" and make screenshots read as stale mail.
   */
  receivedDaysAgo?: number
  /** Local wall-clock time within that day, `HH:MM`. Defaults to 09:00. */
  receivedAt?: string
  from: string
  to: string
  cc?: string
  bcc?: string
  replyTo?: string
  /** Optional List-Id header for split-inbox fixtures. */
  listId?: string
  /** RFC Message-ID header, preferably in canonical angle-bracket form. */
  messageId?: string
  /** RFC References chain, written as one folded-capable header value. */
  references?: string[]
  subject: string
  snippet?: string
  bodyText?: string
  bodyHtml?: string
  attachments?: {
    attachmentId: string
    filename?: string
    mimeType?: string
    sizeBytes?: number
    contentId?: string
    dataBase64Url?: string
  }[]
}

interface SeedThread {
  id: string
  historyId?: string
  messages: SeedMessage[]
}

interface SeedFixture {
  account: string
  labels?: LabelRow[]
  threads: SeedThread[]
  /** E2E-only Gmail snapshots that are not imported until an explicit server search fetches them. */
  remoteThreads?: SeedThread[]
  /** Exact Gmail q= responses for the remote snapshots, keeping the provider seam query-aware. */
  remoteSearches?: Record<string, string[]>
  /** Opt into production split initialization. Existing broad fixtures stay unsplit. */
  splitSetup?: boolean
}

export interface SeedLoadOptions {
  /** E2E-only authoritative catalog override; ordinary seeding uses the fixture catalog. */
  labels?: LabelRow[]
}

export interface SeedLoadResult {
  accountId: string
  labelsChanged: boolean
}

function readSeedFixture(path: string): SeedFixture {
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as SeedFixture
  if (!fixture.account || !Array.isArray(fixture.threads)) throw new Error('Invalid ATTN_TEST_SEED fixture')
  return fixture
}

function payloadFor(message: SeedMessage): GmailPart {
  const bodyParts: GmailPart[] = []
  if (message.bodyText !== undefined) {
    bodyParts.push({
      mimeType: 'text/plain',
      body: { data: Buffer.from(message.bodyText).toString('base64url') }
    })
  }
  if (message.bodyHtml !== undefined) {
    bodyParts.push({
      mimeType: 'text/html',
      body: { data: Buffer.from(message.bodyHtml).toString('base64url') }
    })
  }
  return {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'From', value: message.from },
      { name: 'To', value: message.to },
      { name: 'Subject', value: message.subject },
      ...(message.cc ? [{ name: 'Cc', value: message.cc }] : []),
      ...(message.bcc ? [{ name: 'Bcc', value: message.bcc }] : []),
      ...(message.replyTo ? [{ name: 'Reply-To', value: message.replyTo }] : []),
      ...(message.listId ? [{ name: 'List-Id', value: message.listId }] : []),
      ...(message.messageId ? [{ name: 'Message-ID', value: message.messageId }] : []),
      ...(message.references?.length
        ? [{ name: 'References', value: message.references.join('\r\n\t') }]
        : [])
    ],
    parts: [
      ...bodyParts,
      ...(message.attachments ?? []).map((attachment) => ({
        ...(attachment.dataBase64Url ? { partId: attachment.attachmentId.replace(/^inline:/, '') } : {}),
        mimeType: attachment.mimeType ?? 'application/octet-stream',
        filename: attachment.filename,
        ...(attachment.contentId
          ? { headers: [{ name: 'Content-ID', value: `<${attachment.contentId}>` }] }
          : {}),
        body: attachment.dataBase64Url
          ? { data: attachment.dataBase64Url, size: attachment.sizeBytes ?? 0 }
          : { attachmentId: attachment.attachmentId, size: attachment.sizeBytes ?? 0 }
      }))
    ]
  }
}

export function resolveInternalDate(message: SeedMessage, now = Date.now()): string {
  if (message.receivedDaysAgo === undefined) {
    if (message.internalDate === undefined) {
      throw new Error(`Seed message ${message.id} needs internalDate or receivedDaysAgo`)
    }
    return message.internalDate
  }
  const [hours, minutes] = (message.receivedAt ?? '09:00').split(':').map(Number)
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    throw new Error(`Seed message ${message.id} has an unparseable receivedAt`)
  }
  const today = new Date(now)
  const at = new Date(
    today.getFullYear(),
    today.getMonth(),
    today.getDate() - message.receivedDaysAgo,
    hours,
    minutes
  )
  return String(at.getTime())
}

function gmailThreadFor(thread: SeedThread, importedAt: number): GmailThread {
  return {
    id: thread.id,
    historyId: thread.historyId,
    messages: thread.messages.map((message) => ({
      id: message.id,
      threadId: thread.id,
      labelIds: message.labelIds,
      internalDate: resolveInternalDate(message, importedAt),
      snippet: message.snippet,
      payload: payloadFor(message)
    }))
  }
}

/** Read one authoritative seeded snapshot for an e2e provider seam. */
export function readSeedThread(path: string, threadId: string, now = Date.now()): GmailThread | null {
  const fixture = readSeedFixture(path)
  const thread = [...fixture.threads, ...(fixture.remoteThreads ?? [])].find(
    (candidate) => candidate.id === threadId
  )
  return thread ? gmailThreadFor(thread, now) : null
}

/** List the snapshots returned by the seeded server-search provider for one Gmail query. */
export function readSeedRemoteThreadIds(path: string, query: string): string[] {
  const fixture = readSeedFixture(path)
  const remoteIds = new Set((fixture.remoteThreads ?? []).map((thread) => thread.id))
  const configured = fixture.remoteSearches?.[query] ?? []
  return [...new Set(configured)].filter((threadId) => remoteIds.has(threadId))
}

export function loadSeed(db: Db, path: string, options: SeedLoadOptions = {}): SeedLoadResult {
  const fixture = readSeedFixture(path)
  const importedAt = Date.now()
  let labelsChanged = false

  db.transaction(() => {
    // Same write path as real sync (persist.ts) — the seam must never grow
    // parallel SQL that can drift from what production writes.
    ensureAccount(db, fixture.account, fixture.account)
    if (fixture.splitSetup) ensureSplitSetup(db, fixture.account)
    labelsChanged = upsertLabels(db, fixture.account, options.labels ?? fixture.labels ?? [])
    for (const thread of fixture.threads) {
      persistThread(db, fixture.account, gmailThreadFor(thread, importedAt))
    }
    // Seeded stores are complete local snapshots and never contact Gmail. Mark
    // foreground backfill, derived metadata passes, and the FTS backfill
    // complete so relaunches stay settled; persistThread indexed every row.
    db.prepare(
      `INSERT INTO sync_state
       (account_id, backfill_cursor, sweep_cursor, split_metadata_cursor, fts_cursor)
       VALUES (?, 'done', 'done', 'done', 'done')
       ON CONFLICT(account_id) DO UPDATE SET
         backfill_cursor = excluded.backfill_cursor,
         sweep_cursor = COALESCE(sync_state.sweep_cursor, excluded.sweep_cursor),
         split_metadata_cursor = COALESCE(sync_state.split_metadata_cursor, excluded.split_metadata_cursor),
         fts_cursor = COALESCE(sync_state.fts_cursor, excluded.fts_cursor)`
    ).run(fixture.account)
  })()

  console.log(`[seed] loaded ${fixture.threads.length} threads for ${fixture.account}`)
  return { accountId: fixture.account, labelsChanged }
}
