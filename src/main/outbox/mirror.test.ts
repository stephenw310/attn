import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import type { MailActionProvider } from '../sync/provider'
import { draftAttachmentsForMirror, type StoredDraftAttachment } from './draftAttachments'
import {
  deleteDraftCheckpoint,
  drainDraftMirrors,
  isRetryableAttachmentFilesystemError,
  loadDraftMimeAttachments,
  prepareDraftMimeAttachments,
  saveDraftCheckpoint
} from './mirror'

describe('draft mirror recovery', () => {
  it('clears a Gmail-deleted id and recreates the draft', async () => {
    const saveDraft = vi
      .fn()
      .mockRejectedValueOnce(new GmailApiError(404, 'gone'))
      .mockResolvedValueOnce('replacement-id')
    const onRemoteMissing = vi.fn(() => true)

    await expect(saveDraftCheckpoint({ saveDraft }, 'deleted-id', 'raw', onRemoteMissing)).resolves.toBe(
      'replacement-id'
    )
    expect(onRemoteMissing).toHaveBeenCalledOnce()
    expect(saveDraft).toHaveBeenNthCalledWith(1, { id: 'deleted-id', raw: 'raw' })
    expect(saveDraft).toHaveBeenNthCalledWith(2, { id: null, raw: 'raw' })
  })

  it('does not recreate a remotely deleted draft after local discard wins the race', async () => {
    const saveDraft = vi.fn().mockRejectedValue(new GmailApiError(404, 'gone'))
    await expect(saveDraftCheckpoint({ saveDraft }, 'deleted-id', 'raw', () => false)).resolves.toBeNull()
    expect(saveDraft).toHaveBeenCalledOnce()
  })

  it('treats an already-deleted Gmail draft as a successful discard', async () => {
    const provider = {
      deleteDraft: vi.fn().mockRejectedValue(new GmailApiError(404, 'gone'))
    } satisfies Pick<MailActionProvider, 'deleteDraft'>
    await expect(deleteDraftCheckpoint(provider, 'deleted-id')).resolves.toBe(true)
  })
})

describe('draft mirror attachments', () => {
  const attachment = (spoolPath: string): StoredDraftAttachment => ({
    id: 'attachment-1',
    filename: 'notes.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 4,
    spoolPath
  })

  it('distinguishes retryable filesystem failures from a missing owned file', () => {
    expect(isRetryableAttachmentFilesystemError({ code: 'EACCES' })).toBe(true)
    expect(isRetryableAttachmentFilesystemError({ code: 'EIO' })).toBe(true)
    expect(isRetryableAttachmentFilesystemError({ code: 'ENOENT' })).toBe(false)
  })

  it('rejects a stored path outside the owning draft directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attn-mirror-'))
    const outside = join(root, 'secret.txt')
    await writeFile(outside, 'nope')

    await expect(
      loadDraftMimeAttachments('draft-1', [attachment(outside)], {} as MailActionProvider, root)
    ).rejects.toThrow('escaped its draft')
  })

  it('loads ordinary attachments from the main-owned spool directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attn-mirror-'))
    const draftRoot = join(root, 'draft-1')
    const path = join(draftRoot, 'notes.pdf')
    await mkdir(draftRoot)
    await writeFile(path, 'data')

    const loaded = await loadDraftMimeAttachments(
      'draft-1',
      [attachment(path)],
      {} as MailActionProvider,
      root
    )
    expect(loaded).toHaveLength(1)
    expect(loaded[0].inline).toBeUndefined()
    expect(Buffer.from(loaded[0].content).toString()).toBe('data')
  })

  it('keeps main-owned spool paths out of missing-file errors before and during streaming', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attn-mirror-'))
    const draftRoot = join(root, 'draft-1')
    const path = join(draftRoot, 'notes.pdf')
    await mkdir(draftRoot)

    const missingError = await prepareDraftMimeAttachments(
      'draft-1',
      [attachment(path)],
      {} as MailActionProvider,
      root
    ).catch((error: unknown) => error)
    expect(String(missingError)).toContain('local attachment unavailable: notes.pdf')
    expect(String(missingError)).not.toContain(root)

    await writeFile(path, 'data')
    const [prepared] = await prepareDraftMimeAttachments(
      'draft-1',
      [attachment(path)],
      {} as MailActionProvider,
      root
    )
    await rm(path)
    const streamError = await (async () => {
      try {
        for await (const _chunk of prepared.open()) {
          // Drain the source to surface a late filesystem failure.
        }
      } catch (error) {
        return error
      }
      return null
    })()
    expect(String(streamError)).toContain('local attachment unavailable: notes.pdf')
    expect(String(streamError)).not.toContain(root)
  })

  it('keeps local file bytes out of autosave while retaining inline and remote MIME parts', () => {
    const localFile = attachment('/owned/outbox/draft-1/notes.pdf')
    const inline = { ...attachment('/owned/outbox/draft-1/image.png'), id: 'inline', inline: true }
    const remote = {
      ...attachment(''),
      id: 'remote',
      remoteMessageId: 'message-1',
      remoteAttachmentId: 'attachment-1'
    }

    expect(draftAttachmentsForMirror([localFile, inline, remote]).map((item) => item.id)).toEqual([
      'inline',
      'remote'
    ])
  })
})

describe('draft mirror selection', () => {
  it('mirrors a draft whose only meaningful authored content is HTML', async () => {
    const pending = vi
      .fn()
      .mockReturnValueOnce([
        {
          id: 'html-only',
          state: 'drafted',
          gmail_draft_id: null,
          to_json: '[]',
          cc_json: '[]',
          bcc_json: '[]',
          subject: '',
          body_html: '<hr>',
          body_text: '',
          attachments_json: '[]',
          thread_id: null,
          in_reply_to: null,
          references_json: '[]',
          quote_html: '',
          quote_text: '',
          local_revision: 1
        }
      ])
      .mockReturnValueOnce([])
    const update = vi.fn(() => ({ changes: 1 }))
    const db = {
      prepare: vi.fn((sql: string) =>
        sql.includes('SELECT id, state, gmail_draft_id') ? { all: pending } : { run: update }
      )
    } as unknown as Db
    const saveDraft = vi.fn(
      async (_draft: { id: string | null; raw: string; threadId?: string | null }) => 'gmail-html-only'
    )

    await drainDraftMirrors(db, 'account', { saveDraft } as unknown as MailActionProvider)

    expect(saveDraft).toHaveBeenCalledOnce()
    expect(saveDraft.mock.calls[0]?.[0].id).toBeNull()
    expect(update).toHaveBeenCalledOnce()
  })
})
