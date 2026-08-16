import { describe, expect, it, vi } from 'vitest'
import { emptyDraftInput } from '../../shared/drafts'
import type { Db } from '../db'
import { publicDraftAttachment, type StoredDraftAttachment } from './draftAttachments'
import { canonicalizeRendererDraft, discardDraft, isEmptyDraft, requestDraftMirror } from './drafts'

const stored: StoredDraftAttachment = {
  id: 'owned-attachment',
  filename: 'image.png',
  mimeType: 'image/png',
  sizeBytes: 3,
  spoolPath: '/owned/outbox/draft-1/image.png',
  contentId: 'image@attn.local',
  inline: true
}

describe('draft attachment trust boundary', () => {
  it('never exposes storage locators in renderer-facing drafts', () => {
    expect(publicDraftAttachment(stored)).toEqual({
      id: 'owned-attachment',
      filename: 'image.png',
      mimeType: 'image/png',
      sizeBytes: 3,
      contentId: 'image@attn.local',
      inline: true
    })
    expect(publicDraftAttachment(stored)).not.toHaveProperty('spoolPath')
  })

  it('replaces renderer attachment objects with the main-owned stored set', () => {
    const db = {
      prepare: vi.fn(() => ({ get: vi.fn(() => ({ attachments_json: JSON.stringify([stored]) })) }))
    } as unknown as Db
    const malicious = {
      ...emptyDraftInput(),
      id: 'draft-1',
      attachments: [
        {
          id: 'fake',
          filename: 'secret',
          mimeType: 'image/png',
          sizeBytes: 100,
          inline: true,
          contentId: 'secret',
          spoolPath: '/private/secret'
        }
      ]
    }

    const canonical = canonicalizeRendererDraft(db, 'account', malicious)
    expect(canonical.attachments).toEqual([stored])
  })
})

describe('draft lifecycle guards', () => {
  it('reports whether discard actually transitioned an open composer', () => {
    const discarded = vi.fn(() => ({ changes: 1 }))
    const unavailable = vi.fn(() => ({ changes: 0 }))

    expect(
      discardDraft({ prepare: vi.fn(() => ({ run: discarded })) } as unknown as Db, 'account', 'open-draft')
    ).toBe(true)
    expect(
      discardDraft(
        { prepare: vi.fn(() => ({ run: unavailable })) } as unknown as Db,
        'account',
        'closed-draft'
      )
    ).toBe(false)
  })

  it('treats HTML and plain-text quote content as meaningful mirror work', () => {
    expect(isEmptyDraft({ ...emptyDraftInput(), bodyHtml: '<hr>' })).toBe(false)
    expect(isEmptyDraft({ ...emptyDraftInput(), quoteText: 'Quoted text' })).toBe(false)

    for (const content of [
      { body_html: '<hr>', quote_html: '', quote_text: '' },
      { body_html: '', quote_html: '', quote_text: 'Quoted text' }
    ]) {
      const db = {
        prepare: vi.fn(() => ({
          get: vi.fn(() => ({
            to_json: '[]',
            cc_json: '[]',
            bcc_json: '[]',
            subject: '',
            body_text: '',
            attachments_json: '[]',
            ...content
          }))
        }))
      } as unknown as Db

      expect(requestDraftMirror(db, 'account', 'draft-1')).toBe(true)
    }
  })
})
