import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { GmailApiError } from '../gmail/client'
import type { MailActionProvider } from '../sync/provider'
import type { StoredDraftAttachment } from './draftAttachments'
import { deleteDraftCheckpoint, loadDraftMimeAttachments, saveDraftCheckpoint } from './mirror'

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
})
