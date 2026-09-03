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
  reopenThreadDraft,
  requestDraftMirror,
  saveDraft,
  takeRecoveredDraft,
  upgradeReplyToReplyAll
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

describe('message-specific draft reuse', () => {
  it.each(['reply', 'forward'] as const)('reuses only the matching source and account for %s', (kind) => {
    const db = openDatabase(':memory:')
    try {
      const input = { ...emptyDraftInput(), kind, threadId: 'thread', bodyText: 'Keep my words' }
      const originalId = saveDraft(db, 'account', { ...input, sourceMessageId: 'original' }, 1)
      const newestId = saveDraft(db, 'account', { ...input, sourceMessageId: 'colleague' }, 2)
      saveDraft(db, 'other-account', { ...input, sourceMessageId: 'original' }, 3)
      const groupKind = kind === 'reply' ? 'replyAll' : kind
      expect(reopenThreadDraft(db, 'account', 'thread', groupKind, undefined, 4)?.id).toBe(newestId)
      expect(reopenThreadDraft(db, 'account', 'thread', groupKind, 'original', 5)?.id).toBe(originalId)
      expect(reopenThreadDraft(db, 'account', 'thread', groupKind, 'missing', 6)).toBeNull()
      expect(reopenThreadDraft(db, 'account', 'other-thread', groupKind, 'original', 7)).toBeNull()
    } finally {
      db.close()
    }
  })
})

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

describe('draft store CRUD', () => {
  function account(): Db {
    const db = openDatabase(':memory:')
    db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, ?)').run(
      'account',
      'account@example.com',
      1
    )
    return db
  }

  function state(db: Db, id: string): string | undefined {
    return (db.prepare('SELECT state FROM outbox WHERE id = ?').get(id) as { state: string } | undefined)
      ?.state
  }

  it('reopens the newest thread draft that was closed, and returns it composing', () => {
    const db = account()
    try {
      const id = saveDraft(
        db,
        'account',
        { ...emptyDraftInput(), kind: 'reply', threadId: 'thread', bodyText: 'Drafted' },
        10
      )
      expect(closeDraft(db, 'account', id, 20)).toBe('saved')
      expect(state(db, id)).toBe('drafted')

      expect(reopenThreadDraft(db, 'account', 'thread', 'reply', undefined, 30)).toMatchObject({
        id,
        updatedAt: 30
      })
      expect(state(db, id)).toBe('composing')
      // A forward never adopts the reply slot, and neither does a stranger thread.
      expect(reopenThreadDraft(db, 'account', 'thread', 'forward', undefined, 40)).toBeNull()
    } finally {
      db.close()
    }
  })

  it('deletes a closed empty draft outright but tombstones one Gmail already holds', () => {
    const db = account()
    try {
      const local = saveDraft(db, 'account', { ...emptyDraftInput(), kind: 'reply', threadId: 't' }, 10)
      expect(closeDraft(db, 'account', local, 20)).toBe('discarded')
      expect(state(db, local)).toBeUndefined()

      const mirrored = saveDraft(db, 'account', { ...emptyDraftInput(), kind: 'reply', threadId: 't' }, 30)
      db.prepare("UPDATE outbox SET gmail_draft_id = 'remote-1' WHERE id = ?").run(mirrored)
      expect(closeDraft(db, 'account', mirrored, 40)).toBe('discarded')
      // The row survives so the mirror can delete the remote draft, but it
      // carries none of the content the user discarded.
      expect(
        db.prepare('SELECT state, subject, body_html, thread_id FROM outbox WHERE id = ?').get(mirrored)
      ).toEqual({ state: 'discarding', subject: '', body_html: '', thread_id: null })

      expect(() => closeDraft(db, 'account', 'missing', 50)).toThrow('draft is unavailable')
    } finally {
      db.close()
    }
  })

  it('lists newest first and leaves blank and signature-only drafts out', () => {
    const db = account()
    try {
      const older = saveDraft(db, 'account', { ...emptyDraftInput(), subject: 'Older' }, 10)
      const newer = saveDraft(db, 'account', { ...emptyDraftInput(), subject: 'Newer' }, 20)
      saveDraft(db, 'account', emptyDraftInput(), 30)
      saveDraft(db, 'other-account', { ...emptyDraftInput(), subject: 'Elsewhere' }, 40)

      cachePrimarySendAs(db, 'account', {
        sendAsEmail: 'account@example.com',
        displayName: 'Account',
        signature: '<div>Sent from Attn</div>'
      })
      const prepared = prepareDraftWithCachedPrimarySignature(db, 'account', emptyDraftInput())
      saveDraft(db, 'account', prepared.draft, 50, prepared.defaultSignatureFingerprint)

      // Both excluded rows are really in the store: one is caught by the SQL
      // blank-field guard, the other only by the signature fingerprint.
      expect(
        (db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE account_id = 'account'").get() as { n: number }).n
      ).toBe(4)
      expect(listDrafts(db, 'account').map((draft) => draft.subject)).toEqual(['Newer', 'Older'])

      db.prepare('UPDATE outbox SET updated_at = ? WHERE id = ?').run(60, older)
      expect(listDrafts(db, 'account').map((draft) => draft.id)).toEqual([older, newer])
    } finally {
      db.close()
    }
  })

  it('recovers the most recently touched open draft, and nothing once it is closed', () => {
    const db = account()
    try {
      saveDraft(db, 'account', { ...emptyDraftInput(), subject: 'First' }, 10)
      const newest = saveDraft(db, 'account', { ...emptyDraftInput(), subject: 'Second' }, 20)

      expect(takeRecoveredDraft(db, 'account')?.id).toBe(newest)
      expect(takeRecoveredDraft(db, 'other-account')).toBeNull()

      closeDraft(db, 'account', newest, 30)
      expect(takeRecoveredDraft(db, 'account')?.subject).toBe('First')
    } finally {
      db.close()
    }
  })

  it('upgrades a reply to reply-all without losing authored or manual recipients', () => {
    const db = account()
    try {
      const id = saveDraft(
        db,
        'account',
        {
          ...emptyDraftInput(),
          kind: 'reply',
          threadId: 'thread',
          bodyText: 'Mine',
          to: [{ name: 'Author', email: 'author@example.com' }],
          cc: [{ name: '', email: 'manual@example.com' }]
        },
        10
      )
      const planned = {
        to: [{ name: 'Author', email: 'AUTHOR@example.com' }],
        cc: [
          { name: '', email: 'manual@example.com' },
          { name: '', email: 'everyone@example.com' }
        ]
      }

      const upgraded = upgradeReplyToReplyAll(db, 'account', id, planned.to, planned.cc, 20)
      expect(upgraded).toMatchObject({ kind: 'replyAll', bodyText: 'Mine', updatedAt: 20 })
      expect(upgraded?.to.map((address) => address.email)).toEqual(['author@example.com'])
      expect(upgraded?.cc.map((address) => address.email)).toEqual([
        'manual@example.com',
        'everyone@example.com'
      ])
      expect(
        (db.prepare('SELECT local_revision FROM outbox WHERE id = ?').get(id) as { local_revision: number })
          .local_revision
      ).toBe(2)

      // Already upgraded: the second call is a plain read, not a second merge.
      expect(upgradeReplyToReplyAll(db, 'account', id, planned.to, planned.cc, 30)).toMatchObject({
        kind: 'replyAll',
        updatedAt: 20
      })
    } finally {
      db.close()
    }
  })
})
