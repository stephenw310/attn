import { describe, expect, it } from 'vitest'
import {
  parseStoredDraftAttachments,
  publicDraftAttachment,
  publicDraftAttachments,
  type StoredDraftAttachment
} from './draftAttachments'

const stored: StoredDraftAttachment = {
  id: 'attachment-1',
  filename: 'report.pdf',
  mimeType: 'application/pdf',
  sizeBytes: 12,
  spoolPath: '/profile/spool/draft-1/attachment-1',
  planned: true,
  remoteMessageId: 'msg-1',
  remoteAttachmentId: 'att-1',
  remoteInlineData: 'ZmFrZQ=='
}

describe('publicDraftAttachment', () => {
  it('drops every main-only locator instead of listing the safe fields', () => {
    // The bridge hands this straight to the sandboxed renderer, so the guard
    // is the exact key set: a new stored field must not ride along by default.
    expect(Object.keys(publicDraftAttachment(stored)).sort()).toEqual([
      'filename',
      'id',
      'mimeType',
      'sizeBytes'
    ])
    expect(publicDraftAttachment(stored)).toEqual({
      id: 'attachment-1',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 12
    })
  })

  it('carries the inline identity a CID body image needs', () => {
    expect(publicDraftAttachment({ ...stored, contentId: 'image@attn.local', inline: true })).toEqual({
      id: 'attachment-1',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 12,
      contentId: 'image@attn.local',
      inline: true
    })
  })

  it('omits the optional keys rather than setting them undefined', () => {
    // `useComposerAttachments` filters chips on `!attachment.inline` and the
    // draft snapshot is structured-cloned, so an explicit `undefined` would
    // both survive the clone and change equality against a stored draft.
    const attachment = publicDraftAttachment({ ...stored, inline: false })
    expect('inline' in attachment).toBe(false)
    expect('contentId' in attachment).toBe(false)
    expect(JSON.parse(JSON.stringify(attachment))).toEqual(attachment)
  })
})

describe('publicDraftAttachments', () => {
  it('preserves order and maps each attachment through the same filter', () => {
    const second: StoredDraftAttachment = { ...stored, id: 'attachment-2', filename: 'notes.txt' }
    expect(publicDraftAttachments([stored, second]).map((attachment) => attachment.id)).toEqual([
      'attachment-1',
      'attachment-2'
    ])
    expect(publicDraftAttachments([])).toEqual([])
    expect(publicDraftAttachments([stored])[0]).toEqual(publicDraftAttachment(stored))
  })
})

describe('parseStoredDraftAttachments', () => {
  it('round-trips the stored column, main-only fields included', () => {
    expect(parseStoredDraftAttachments(JSON.stringify([stored]))).toEqual([stored])
    expect(parseStoredDraftAttachments('[]')).toEqual([])
  })

  it('throws on a column that is not JSON, rather than returning a partial list', () => {
    // Callers wrap the read in their own transaction; a silent empty list would
    // orphan spooled files and drop the user's attachments from the draft.
    expect(() => parseStoredDraftAttachments('not json')).toThrow()
  })
})
