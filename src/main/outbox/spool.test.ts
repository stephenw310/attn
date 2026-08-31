import { existsSync } from 'node:fs'
import * as filesystem from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyDraftInput } from '../../shared/drafts'
import { openDatabase } from '../db'
import { parseStoredDraftAttachments } from './draftAttachments'
import { saveDraft } from './drafts'
import {
  deleteOutboxSpool,
  MAX_DRAFT_ATTACHMENT_BYTES,
  MAX_DRAFT_ATTACHMENT_PATHS,
  reconcileOutboxSpool,
  removeDraftAttachment,
  spoolDraftAttachments,
  validateAttachmentCap
} from './spool'

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rm: vi.fn(actual.rm) }
})

const roots: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function testStore(): Promise<{
  root: string
  db: ReturnType<typeof openDatabase>
  draftId: string
}> {
  const root = await mkdtemp(join(tmpdir(), 'attn-spool-'))
  roots.push(root)
  const db = openDatabase(join(root, 'attn.db'))
  db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)').run(
    'me@example.com',
    'me@example.com',
    1
  )
  const draftId = saveDraft(db, 'me@example.com', emptyDraftInput(), 10)
  return { root, db, draftId }
}

describe('attachment cap math', () => {
  it('enforces both the per-file and aggregate 25 MB limits without touching disk', () => {
    expect(() => validateAttachmentCap(0, [MAX_DRAFT_ATTACHMENT_BYTES])).not.toThrow()
    expect(() => validateAttachmentCap(0, [MAX_DRAFT_ATTACHMENT_BYTES + 1])).toThrow(
      'Each attachment must be 25 MB or less'
    )
    expect(() => validateAttachmentCap(MAX_DRAFT_ATTACHMENT_BYTES - 2, [1, 2])).toThrow(
      'Attachments must total 25 MB or less'
    )
  })
})

describe('attachment spool ownership', () => {
  it('reports deletion errors, retains the files for retry, and awaits successful removal', async () => {
    const { root, db, draftId } = await testStore()
    const source = join(root, 'private.txt')
    await writeFile(source, 'private attachment')
    await spoolDraftAttachments(db, root, 'me@example.com', draftId, [source])
    const directory = join(root, 'outbox', draftId)
    vi.mocked(filesystem.rm).mockRejectedValueOnce(new Error('EACCES: attachment is locked'))

    await expect(deleteOutboxSpool(root, draftId)).rejects.toThrow('EACCES')
    expect(existsSync(directory)).toBe(true)
    await deleteOutboxSpool(root, draftId)
    expect(existsSync(directory)).toBe(false)
    await expect(deleteOutboxSpool(root, draftId)).resolves.toBeUndefined()
    db.close()
  })

  it('rejects deletion outside an owned draft directory', async () => {
    const { root, db } = await testStore()
    const source = join(root, 'private.txt')
    await writeFile(source, 'must survive')
    await expect(deleteOutboxSpool(root, '..')).rejects.toThrow('Invalid attachment spool directory')
    await expect(deleteOutboxSpool(root, '.')).rejects.toThrow('Invalid attachment spool directory')
    expect(await readFile(source, 'utf8')).toBe('must survive')
    db.close()
  })

  it('retries a compare-and-swap conflict instead of discarding copied bytes', async () => {
    const { root, db, draftId } = await testStore()
    const source = join(root, 'dropped.txt')
    await writeFile(source, 'dropped')
    // Stands in for a paste landing between this call's read and its write.
    const pasted = {
      id: 'pasted-image',
      filename: 'pasted.png',
      mimeType: 'image/png',
      sizeBytes: 4,
      spoolPath: join(root, 'outbox', draftId, 'pasted-image'),
      contentId: 'cid@attn.local',
      inline: true
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
              ).run(JSON.stringify([pasted]), draftId)
            }
            return statement.run(...args)
          }
        }
      }
    } as unknown as typeof db

    await expect(
      spoolDraftAttachments(racingDb, root, 'me@example.com', draftId, [source])
    ).resolves.toMatchObject({ changed: true })

    const row = db.prepare('SELECT attachments_json FROM outbox WHERE id = ?').get(draftId) as {
      attachments_json: string
    }
    const stored = parseStoredDraftAttachments(row.attachments_json)
    expect(stored.map((attachment) => attachment.filename)).toEqual(['pasted.png', 'dropped.txt'])
    expect(existsSync(stored[1].spoolPath)).toBe(true)
  })

  it('enforces the path-count cap for picker and drop callers in the shared spool boundary', async () => {
    const { root, db, draftId } = await testStore()
    const source = join(root, 'one.txt')
    await writeFile(source, 'one')

    await expect(
      spoolDraftAttachments(
        db,
        root,
        'me@example.com',
        draftId,
        Array.from({ length: MAX_DRAFT_ATTACHMENT_PATHS + 1 }, () => source)
      )
    ).rejects.toThrow('Attach no more than 100 files at once')
    expect(existsSync(join(root, 'outbox', draftId))).toBe(false)
    db.close()
  })

  it('does not revise a draft when the file picker is cancelled', async () => {
    const { root, db, draftId } = await testStore()
    const before = db.prepare('SELECT local_revision FROM outbox WHERE id = ?').get(draftId) as {
      local_revision: number
    }

    await expect(spoolDraftAttachments(db, root, 'me@example.com', draftId, [])).resolves.toEqual({
      attachments: [],
      changed: false
    })
    const after = db.prepare('SELECT local_revision FROM outbox WHERE id = ?').get(draftId) as {
      local_revision: number
    }
    expect(after.local_revision).toBe(before.local_revision)
    db.close()
  })

  it('copies bytes under the draft, records safe metadata, and removes one attachment', async () => {
    const { root, db, draftId } = await testStore()
    const source = join(root, 'quarterly-notes.pdf')
    await writeFile(source, 'durable attachment bytes')

    const added = await spoolDraftAttachments(db, root, 'me@example.com', draftId, [source], 20)
    expect(added.attachments).toEqual([
      expect.objectContaining({
        filename: 'quarterly-notes.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 24
      })
    ])
    expect(added.attachments[0]).not.toHaveProperty('spoolPath')

    const row = db.prepare('SELECT attachments_json FROM outbox WHERE id = ?').get(draftId) as {
      attachments_json: string
    }
    const stored = parseStoredDraftAttachments(row.attachments_json)
    expect(stored[0].spoolPath).toContain(join('outbox', draftId))
    await rm(source)
    await expect(readFile(stored[0].spoolPath, 'utf8')).resolves.toBe('durable attachment bytes')

    const removed = await removeDraftAttachment(db, root, 'me@example.com', draftId, stored[0].id, 30)
    expect(removed.attachments).toEqual([])
    expect(existsSync(stored[0].spoolPath)).toBe(false)
    db.close()
  })

  it('uses a bounded storage name while preserving a near-limit display filename', async () => {
    const { root, db, draftId } = await testStore()
    const filename = `${'quarterly-notes-'.repeat(15)}.txt`
    const source = join(root, filename)
    await writeFile(source, 'data')

    await spoolDraftAttachments(db, root, 'me@example.com', draftId, [source])
    const row = db.prepare('SELECT attachments_json FROM outbox WHERE id = ?').get(draftId) as {
      attachments_json: string
    }
    const [stored] = parseStoredDraftAttachments(row.attachments_json)

    expect(stored.filename).toBe(filename)
    expect(basename(stored.spoolPath)).toHaveLength(36)
    db.close()
  })

  it('does not expose source or profile paths through filesystem errors', async () => {
    const { root, db, draftId } = await testStore()
    const missing = join(root, 'private-source-name.txt')

    await expect(spoolDraftAttachments(db, root, 'me@example.com', draftId, [missing])).rejects.not.toThrow(
      root
    )

    const source = join(root, 'available.txt')
    await writeFile(source, 'data')
    await expect(
      spoolDraftAttachments(db, join(root, 'attn.db'), 'me@example.com', draftId, [source])
    ).rejects.not.toThrow(root)
    db.close()
  })

  it('removes orphaned directories and files while retaining referenced spool bytes', async () => {
    const { root, db, draftId } = await testStore()
    const source = join(root, 'keep.bin')
    await writeFile(source, 'keep')
    await spoolDraftAttachments(db, root, 'me@example.com', draftId, [source])
    const row = db.prepare('SELECT attachments_json FROM outbox WHERE id = ?').get(draftId) as {
      attachments_json: string
    }
    const [stored] = parseStoredDraftAttachments(row.attachments_json)
    const kept = join(root, 'outbox', draftId)
    const orphaned = join(root, 'outbox', 'already-sent')
    const damagedDraftId = saveDraft(db, 'me@example.com', emptyDraftInput(), 11)
    const damaged = join(root, 'outbox', damagedDraftId)
    await mkdir(orphaned, { recursive: true })
    await mkdir(damaged, { recursive: true })
    const orphanedFile = join(kept, 'interrupted-copy.bin')
    await writeFile(orphanedFile, 'remove')
    await writeFile(join(orphaned, 'remove.bin'), 'remove')
    await writeFile(join(damaged, 'preserve.bin'), 'preserve')
    db.prepare("UPDATE outbox SET attachments_json = '{' WHERE id = ?").run(damagedDraftId)

    await reconcileOutboxSpool(db, root)

    expect(existsSync(stored.spoolPath)).toBe(true)
    expect(existsSync(orphanedFile)).toBe(false)
    expect(existsSync(orphaned)).toBe(false)
    expect(existsSync(damaged)).toBe(true)
    db.close()
  })
})
