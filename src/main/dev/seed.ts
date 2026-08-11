import { readFileSync } from 'node:fs'
import type { Db } from '../db'
import type { GmailPart, GmailThread } from '../gmail/parse'
import { persistThread } from '../sync/persist'

interface SeedMessage {
  id: string
  labelIds?: string[]
  internalDate: string
  from: string
  to: string
  subject: string
  snippet?: string
  bodyText?: string
  attachmentFilename?: string
}

interface SeedFixture {
  account: string
  labels?: { id: string; name: string; type: string }[]
  threads: { id: string; historyId?: string; messages: SeedMessage[] }[]
}

function payloadFor(message: SeedMessage): GmailPart {
  const textPart: GmailPart = {
    mimeType: 'text/plain',
    body: { data: Buffer.from(message.bodyText ?? '').toString('base64url') }
  }
  return {
    mimeType: 'multipart/mixed',
    headers: [
      { name: 'From', value: message.from },
      { name: 'To', value: message.to },
      { name: 'Subject', value: message.subject }
    ],
    parts: message.attachmentFilename
      ? [textPart, { mimeType: 'application/octet-stream', filename: message.attachmentFilename, body: {} }]
      : [textPart]
  }
}

export function loadSeed(db: Db, path: string): string {
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as SeedFixture
  if (!fixture.account || !Array.isArray(fixture.threads)) throw new Error('Invalid ATTN_TEST_SEED fixture')

  db.transaction(() => {
    db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)').run(
      fixture.account,
      fixture.account,
      Date.now()
    )
    const insertLabel = db.prepare(
      `INSERT INTO labels (account_id, id, name, type) VALUES (?, ?, ?, ?)
       ON CONFLICT(account_id, id) DO UPDATE SET name = excluded.name, type = excluded.type`
    )
    for (const label of fixture.labels ?? []) {
      insertLabel.run(fixture.account, label.id, label.name, label.type)
    }
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
