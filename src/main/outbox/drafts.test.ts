import { describe, expect, it, vi } from 'vitest'
import { emptyDraftInput } from '../../shared/drafts'
import type { Db } from '../db'
import { publicDraftAttachment, type StoredDraftAttachment } from './draftAttachments'
import {
  canonicalizeRendererDraft,
  closeDraft,
  discardDraft,
  isEmptyDraft,
  requestDraftMirror
} from './drafts'

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

describe('untouched reply and forward drafts', () => {
  function draftRow(overrides: Record<string, unknown>): Record<string, unknown> {
    return {
      id: 'draft-1',
      gmail_draft_id: null,
      gmail_message_id: null,
      state: 'composing',
      kind: 'reply',
      to_json: JSON.stringify([{ name: 'Maya', email: 'maya@example.com' }]),
      cc_json: '[]',
      bcc_json: '[]',
      subject: 'Re: Design notes',
      body_html: '',
      body_text: '',
      attachments_json: '[]',
      thread_id: 't-design',
      source_message_id: 'm-1',
      in_reply_to: '<m-1@example.com>',
      references_json: '[]',
      quote_html: '<blockquote>Original</blockquote>',
      quote_text: '> Original',
      created_at: 1,
      updated_at: 1,
      local_revision: 1,
      planned_revision: 1,
      ...overrides
    }
  }

  function closeWith(row: Record<string, unknown>): { result: string; sql: string[] } {
    const sql: string[] = []
    const db = {
      prepare: vi.fn((statement: string) => {
        sql.push(statement)
        return { get: vi.fn(() => row), run: vi.fn(() => ({ changes: 1 })) }
      })
    } as unknown as Db
    return { result: closeDraft(db, 'account', 'draft-1'), sql }
  }

  it('discards a reply the user never contributed to, despite its planned content', () => {
    // Prefilled recipients, subject and quote make this draft non-empty, so
    // only the planned-revision mark can tell it apart from real user work.
    expect(isEmptyDraft({ ...emptyDraftInput(), quoteHtml: '<blockquote>Original</blockquote>' })).toBe(false)

    const { result, sql } = closeWith(draftRow({}))
    expect(result).toBe('discarded')
    expect(sql.some((statement) => statement.includes('DELETE FROM outbox'))).toBe(true)
  })

  it('saves the same draft once the user edits it past the planned revision', () => {
    const { result, sql } = closeWith(draftRow({ local_revision: 2, body_text: 'My reply' }))
    expect(result).toBe('saved')
    expect(sql.some((statement) => statement.includes("state = 'drafted'"))).toBe(true)
  })

  it('leaves imported Gmail drafts, which carry no plan mark, saved on close', () => {
    const { result } = closeWith(draftRow({ planned_revision: null, local_revision: 1 }))
    expect(result).toBe('saved')
  })
})
