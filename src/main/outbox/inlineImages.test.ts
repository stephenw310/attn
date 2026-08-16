import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { emptyDraftInput } from '../../shared/drafts'
import { type Db, openDatabase } from '../db'
import { parseStoredDraftAttachments } from './draftAttachments'
import { saveDraft } from './drafts'
import { addInlineImage, isSupportedInlineImageMimeType } from './inlineImages'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('inline image MIME allowlist', () => {
  it('allows only image formats safe on both reader and composer bridges', () => {
    for (const mimeType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'IMAGE/PNG']) {
      expect(isSupportedInlineImageMimeType(mimeType)).toBe(true)
    }
    for (const mimeType of ['image/svg+xml', 'image/bmp', 'text/html', 'image/png; charset=utf-8']) {
      expect(isSupportedInlineImageMimeType(mimeType)).toBe(false)
    }
  })
})

describe('inline image attachment mutation', () => {
  it('retries a compare-and-swap conflict without losing a concurrent file attachment', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attn-inline-race-'))
    roots.push(root)
    const db = openDatabase(join(root, 'attn.db'))
    db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)').run(
      'me@example.com',
      'me@example.com',
      1
    )
    const draftId = saveDraft(db, 'me@example.com', emptyDraftInput(), 10)
    const picked = {
      id: 'picked-file',
      filename: 'picked.txt',
      mimeType: 'text/plain',
      sizeBytes: 4,
      spoolPath: join(root, 'outbox', draftId, 'picked-file')
    }
    let raced = false
    const racingDb = {
      prepare: (sql: string) => {
        const statement = db.prepare(sql)
        if (!sql.includes('AND attachments_json = ?')) return statement
        return {
          run: (...args: unknown[]) => {
            if (!raced) {
              raced = true
              db.prepare(
                'UPDATE outbox SET attachments_json = ?, local_revision = local_revision + 1 WHERE id = ?'
              ).run(JSON.stringify([picked]), draftId)
            }
            return statement.run(...args)
          }
        }
      }
    } as unknown as Db

    await expect(
      addInlineImage(racingDb, root, 'me@example.com', draftId, {
        filename: 'pasted.png',
        mimeType: 'image/png',
        dataBase64: Buffer.from('image bytes').toString('base64')
      })
    ).resolves.toMatchObject({ attachment: { filename: 'pasted.png', inline: true } })

    const row = db.prepare('SELECT attachments_json FROM outbox WHERE id = ?').get(draftId) as {
      attachments_json: string
    }
    const stored = parseStoredDraftAttachments(row.attachments_json)
    expect(stored.map((attachment) => attachment.id)).toEqual([
      'picked-file',
      expect.stringMatching(/^[0-9a-f-]+$/)
    ])
    db.close()
  })
})
