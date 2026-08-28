import { describe, expect, it, vi } from 'vitest'
import { emptyDraftInput } from '../../shared/drafts'
import { type Db, openDatabase } from '../db'
import { publicDraftAttachment, type StoredDraftAttachment } from './draftAttachments'
import {
  canonicalizeRendererDraft,
  closeDraft,
  discardDraft,
  isEmptyDraft,
  isUntouchedThreadDraft,
  listDrafts,
  requestDraftMirror,
  saveDraft
} from './drafts'
import { cachePrimarySendAs, prepareDraftWithCachedPrimarySignature } from './sendAs'

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
  it('discards open and closed drafts without touching unavailable rows', () => {
    const db = openDatabase(':memory:')
    try {
      const openId = saveDraft(db, 'account', { ...emptyDraftInput(), subject: 'Open' }, 10)
      const closedId = saveDraft(db, 'account', { ...emptyDraftInput(), subject: 'Closed' }, 20)
      expect(closeDraft(db, 'account', closedId, 30)).toBe('saved')
      expect(listDrafts(db, 'account').map((draft) => draft.id)).toEqual([closedId, openId])

      expect(discardDraft(db, 'account', openId)).toBe(true)
      expect(discardDraft(db, 'account', closedId)).toBe(false)
      expect(discardDraft(db, 'account', closedId, 'drafted')).toBe(true)
      expect(discardDraft(db, 'account', 'missing')).toBe(false)
      expect(listDrafts(db, 'account')).toEqual([])
    } finally {
      db.close()
    }
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
            thread_id: null,
            source_message_id: null,
            in_reply_to: null,
            references_json: '[]',
            kind: 'new',
            local_revision: 1,
            default_signature_fingerprint: null,
            ...content
          }))
        }))
      } as unknown as Db

      expect(requestDraftMirror(db, 'account', 'draft-1')).toBe(true)
    }
  })
})

describe('untouched reply and forward drafts', () => {
  const quoted: StoredDraftAttachment = { ...stored, inline: true }
  const attached: StoredDraftAttachment = { ...stored, id: 'user-file', inline: false }
  const forwarded: StoredDraftAttachment = {
    ...attached,
    id: 'forwarded-file',
    spoolPath: '',
    planned: true,
    remoteMessageId: 'm-design',
    remoteAttachmentId: 'source-file'
  }
  const maya = { name: 'Maya', email: 'maya@example.com' }

  // What `planReply` produces for each entry point, and nothing more.
  const plannedReply = {
    ...emptyDraftInput(),
    kind: 'reply' as const,
    to: [maya],
    subject: 'Re: Design notes',
    threadId: 't-design',
    quoteHtml: '<blockquote>Original</blockquote>',
    quoteText: '> Original',
    attachments: [publicDraftAttachment(quoted)]
  }
  const plannedForward = {
    ...plannedReply,
    kind: 'forward' as const,
    to: [],
    subject: 'Fwd: Design notes',
    attachments: [quoted, forwarded]
  }
  const plannedReplyAll = { ...plannedReply, kind: 'replyAll' as const, cc: [maya] }

  it('does not report a planned reply as blank, so emptiness alone cannot catch it', () => {
    expect(isEmptyDraft(plannedReply)).toBe(false)
    expect(isEmptyDraft(plannedForward)).toBe(false)
  })

  it('treats a draft holding only its plan as untouched', () => {
    expect(isUntouchedThreadDraft(plannedReply)).toBe(true)
    expect(isUntouchedThreadDraft(plannedForward)).toBe(true)
    expect(isUntouchedThreadDraft(plannedReplyAll)).toBe(true)
  })

  it('counts any body the user authored, including a lone pasted image', () => {
    expect(isUntouchedThreadDraft({ ...plannedReply, bodyText: 'Thanks' })).toBe(false)
    expect(isUntouchedThreadDraft({ ...plannedReply, bodyHtml: '<p>Thanks</p>' })).toBe(false)
    expect(isUntouchedThreadDraft({ ...plannedReply, bodyHtml: '<img src="cid:x">' })).toBe(false)
    // Whitespace-only markup is still nothing the user meant to keep.
    expect(isUntouchedThreadDraft({ ...plannedReply, bodyHtml: '<p>&nbsp;</p>' })).toBe(true)
  })

  it('does not count the default signature as authored body content', () => {
    const db = openDatabase(':memory:')
    try {
      cachePrimarySendAs(db, 'account', {
        sendAsEmail: 'account',
        signature: '<div>Best,</div>'
      })
      const prepared = prepareDraftWithCachedPrimarySignature(db, 'account', plannedReply)
      expect(isUntouchedThreadDraft(prepared.draft, false, prepared.defaultSignatureFingerprint)).toBe(true)
      expect(
        isUntouchedThreadDraft(
          {
            ...prepared.draft,
            bodyHtml: `<p>Thanks</p>${prepared.draft.bodyHtml}`,
            bodyText: `Thanks\n${prepared.draft.bodyText}`
          },
          false,
          prepared.defaultSignatureFingerprint
        )
      ).toBe(false)
    } finally {
      db.close()
    }
  })

  it('counts recipients the plan never fills', () => {
    expect(isUntouchedThreadDraft({ ...plannedForward, to: [maya] })).toBe(false)
    expect(isUntouchedThreadDraft({ ...plannedReply, cc: [maya] })).toBe(false)
    expect(isUntouchedThreadDraft({ ...plannedReply, bcc: [maya] })).toBe(false)
    expect(isUntouchedThreadDraft({ ...plannedReplyAll, bcc: [maya] })).toBe(false)
  })

  it('counts a file the user attached but not the quoted inline parts', () => {
    expect(isUntouchedThreadDraft({ ...plannedReply, attachments: [publicDraftAttachment(attached)] })).toBe(
      false
    )
    expect(isUntouchedThreadDraft({ ...plannedReply, attachments: [] })).toBe(true)
  })

  it('does not count source files that the forward plan attached', () => {
    expect(isUntouchedThreadDraft(plannedForward)).toBe(true)
    expect(
      isUntouchedThreadDraft({ ...plannedForward, attachments: [...plannedForward.attachments, attached] })
    ).toBe(false)
  })

  it('counts a forward edit even when removing a planned file leaves no authored field behind', () => {
    expect(isUntouchedThreadDraft({ ...plannedForward, attachments: [] }, true)).toBe(false)
  })

  it('never discards a new draft through this rule', () => {
    expect(isUntouchedThreadDraft(emptyDraftInput())).toBe(false)
  })
})
