import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import type { MailActionProvider } from '../sync/provider'
import type { StoredDraftAttachment } from './draftAttachments'
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

  it('propagates cancellation to the active Gmail checkpoint', async () => {
    const saveDraft = vi.fn(async () => 'draft-id')
    const controller = new AbortController()

    await saveDraftCheckpoint({ saveDraft }, null, 'raw', () => true, null, controller.signal)

    expect(saveDraft).toHaveBeenCalledWith({ id: null, raw: 'raw' }, { signal: controller.signal })
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

  it('propagates shutdown cancellation while hydrating a remote attachment', async () => {
    const getAttachmentData = vi.fn(async () => Buffer.from('remote data').toString('base64url'))
    const controller = new AbortController()
    const remote = {
      ...attachment(''),
      remoteMessageId: 'message-1',
      remoteAttachmentId: 'attachment-1'
    }

    await loadDraftMimeAttachments(
      'draft-1',
      [remote],
      { getAttachmentData } as unknown as MailActionProvider,
      null,
      controller.signal
    )

    expect(getAttachmentData).toHaveBeenCalledWith('message-1', 'attachment-1', {
      signal: controller.signal
    })
  })

  it('streams a spooled file into the Gmail draft and makes its id durable first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'attn-mirror-'))
    await mkdir(join(root, 'draft-1'), { recursive: true })
    const spoolPath = join(root, 'draft-1', 'notes.pdf')
    await writeFile(spoolPath, 'file bytes')

    const pending = vi
      .fn()
      .mockReturnValueOnce([
        {
          id: 'draft-1',
          state: 'drafted',
          gmail_draft_id: null,
          to_json: '[{"name":"","email":"to@example.com"}]',
          cc_json: '[]',
          bcc_json: '[]',
          subject: 'With a file',
          body_html: '<p>Body</p>',
          body_text: 'Body',
          attachments_json: JSON.stringify([{ ...attachment(spoolPath), sizeBytes: 'file bytes'.length }]),
          thread_id: null,
          in_reply_to: null,
          references_json: '[]',
          quote_html: '',
          quote_text: '',
          local_revision: 1
        }
      ])
      .mockReturnValueOnce([])
    const writes: string[] = []
    const db = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes('SELECT id, state, gmail_draft_id')) return { all: pending }
        return {
          run: (...args: unknown[]) => {
            writes.push(`${sql.replace(/\s+/g, ' ').trim()} :: ${JSON.stringify(args)}`)
            return { changes: 1 }
          },
          get: () => undefined
        }
      })
    } as unknown as Db

    const saveDraft = vi.fn(async (_draft: { id: string | null; raw: string }) => 'gmail-1')
    let uploaded = Buffer.alloc(0)
    let idPersistedBeforeUpload = false
    const updateDraft = vi.fn(
      async (draft: { id: string; mime?: { open: () => AsyncIterable<Uint8Array> } }) => {
        idPersistedBeforeUpload = writes.some(
          (write) => write.includes('SET gmail_draft_id = ?') && write.includes('gmail-1')
        )
        const chunks: Buffer[] = []
        for await (const chunk of draft.mime?.open() ?? []) chunks.push(Buffer.from(chunk))
        uploaded = Buffer.concat(chunks)
        return draft.id
      }
    )

    await drainDraftMirrors(
      db,
      'account',
      { saveDraft, updateDraft } as unknown as MailActionProvider,
      () => true,
      root
    )

    // The create mints an id from the body alone; the bytes follow over PUT.
    expect(saveDraft).toHaveBeenCalledOnce()
    const createdRaw = Buffer.from(String(saveDraft.mock.calls[0]?.[0].raw), 'base64url').toString()
    expect(createdRaw).not.toContain('notes.pdf')
    expect(updateDraft).toHaveBeenCalledOnce()
    expect(idPersistedBeforeUpload).toBe(true)
    expect(uploaded.toString()).toContain('filename="notes.pdf"')
    expect(uploaded.toString()).toContain(Buffer.from('file bytes').toString('base64'))

    await rm(root, { recursive: true, force: true })
  })
})

describe('draft mirror selection', () => {
  it('re-reads rotated attachment locators before hydrating a remote-only part', async () => {
    const stale = {
      id: 'remote-1',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 4,
      spoolPath: '',
      remoteMessageId: 'old-message',
      remoteAttachmentId: 'old-attachment'
    }
    const pending = vi
      .fn()
      .mockReturnValueOnce([
        {
          id: 'outbox-1',
          state: 'drafted',
          gmail_draft_id: 'gmail-1',
          to_json: '[]',
          cc_json: '[]',
          bcc_json: '[]',
          subject: 'Report',
          body_html: '<p>see attached</p>',
          body_text: 'see attached',
          attachments_json: JSON.stringify([stale]),
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
        sql.includes('SELECT id, state, gmail_draft_id')
          ? { all: pending }
          : { run: update, get: () => undefined }
      )
    } as unknown as Db
    // Gmail replaced the draft's message on the previous checkpoint, so both
    // ids differ from what the row still stores.
    const getDraft = vi.fn(async () => ({
      id: 'gmail-1',
      message: {
        id: 'new-message',
        threadId: 'thread-1',
        payload: {
          mimeType: 'multipart/mixed',
          parts: [
            { mimeType: 'text/plain', body: { size: 0 } },
            {
              mimeType: 'application/pdf',
              filename: 'report.pdf',
              body: { attachmentId: 'new-attachment', size: 4 }
            }
          ]
        }
      }
    }))
    const getAttachmentData = vi.fn(async () => Buffer.from('data').toString('base64url'))
    const saveDraft = vi.fn(async () => 'gmail-1')

    await drainDraftMirrors(db, 'account', {
      saveDraft,
      getDraft,
      getAttachmentData
    } as unknown as MailActionProvider)

    expect(getDraft).toHaveBeenCalledWith('gmail-1', { signal: undefined })
    expect(getAttachmentData).toHaveBeenCalledWith('new-message', 'new-attachment')
    expect(getAttachmentData).not.toHaveBeenCalledWith('old-message', 'old-attachment')
    expect(saveDraft).toHaveBeenCalledOnce()
  })

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
