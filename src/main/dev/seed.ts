import { readFileSync } from 'node:fs'
import type { Db } from '../db'
import type { GmailPart, GmailThread } from '../gmail/parse'
import { ensureAccount, persistThread, upsertLabels } from '../sync/persist'

interface SeedMessage {
  id: string
  labelIds?: string[]
  internalDate: string
  from: string
  to: string
  cc?: string
  bcc?: string
  replyTo?: string
  subject: string
  snippet?: string
  bodyText?: string
  bodyHtml?: string
  attachments?: {
    attachmentId: string
    filename: string
    mimeType?: string
    sizeBytes?: number
  }[]
}

interface SeedFixture {
  account: string
  labels?: { id: string; name: string; type: string }[]
  threads: { id: string; historyId?: string; messages: SeedMessage[] }[]
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
      ...(message.replyTo ? [{ name: 'Reply-To', value: message.replyTo }] : [])
    ],
    parts: [
      ...bodyParts,
      ...(message.attachments ?? []).map((attachment) => ({
        mimeType: attachment.mimeType ?? 'application/octet-stream',
        filename: attachment.filename,
        body: { attachmentId: attachment.attachmentId, size: attachment.sizeBytes ?? 0 }
      }))
    ]
  }
}

export function loadSeed(db: Db, path: string): string {
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as SeedFixture
  if (!fixture.account || !Array.isArray(fixture.threads)) throw new Error('Invalid ATTN_TEST_SEED fixture')

  db.transaction(() => {
    // Same write path as real sync (persist.ts) — the seam must never grow
    // parallel SQL that can drift from what production writes.
    ensureAccount(db, fixture.account, fixture.account)
    upsertLabels(db, fixture.account, fixture.labels ?? [])
    for (const thread of fixture.threads) {
      const gmailThread: GmailThread = {
        id: thread.id,
        historyId: thread.historyId,
        messages: thread.messages.map((message) => ({
          id: message.id,
          threadId: thread.id,
          labelIds: message.labelIds,
          internalDate: message.internalDate,
          snippet: message.snippet,
          payload: payloadFor(message)
        }))
      }
      persistThread(db, fixture.account, gmailThread)
    }
  })()

  console.log(`[seed] loaded ${fixture.threads.length} threads for ${fixture.account}`)
  return fixture.account
}
