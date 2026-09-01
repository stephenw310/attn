import { describe, expect, it, vi } from 'vitest'
import { emptyDraftInput } from '../../shared/drafts'
import { ATTN_SIGNATURE_LINE, ATTN_SIGNATURE_URL } from '../../shared/settings'
import { openDatabase } from '../db'
import { readAccountSetting, writeAccountSetting, writeAccountSetting as writeSetting } from '../settings'
import { closeDraft, listDrafts, requestDraftMirror, saveDraft } from './drafts'
import {
  ATTN_SIGNATURE_SETTING,
  cachePrimarySendAs,
  hasOnlyDefaultPrimarySignature,
  prepareDraftWithCachedPrimarySignature,
  SEND_AS_DISPLAY_NAME_SETTING,
  SEND_AS_SIGNATURE_HTML_SETTING,
  SEND_AS_SIGNATURE_SOURCE_SETTING,
  SEND_AS_SIGNATURE_TEXT_SETTING,
  syncPrimarySendAs
} from './sendAs'

const ACCOUNT = 'me@example.com'
const SIGNATURE =
  '<div style="position:fixed;color:#123456">Best,</div><div><a href="https://attn.test">Chao</a></div><script>alert(1)</script>'

describe('primary Gmail send-as settings', () => {
  it('caches the display name and a safe editable signature', async () => {
    const db = openDatabase(':memory:')
    const getSendAs = vi.fn(async () => ({
      sendAsEmail: ACCOUNT,
      displayName: ' Chao Wu ',
      signature: SIGNATURE,
      isPrimary: true
    }))
    try {
      await syncPrimarySendAs(db, ACCOUNT, { getSendAs }, { priority: 'polling' })

      expect(getSendAs).toHaveBeenCalledWith(ACCOUNT, { priority: 'polling' })
      expect(readAccountSetting(db, ACCOUNT, SEND_AS_DISPLAY_NAME_SETTING)).toBe('Chao Wu')
      const { draft } = prepareDraftWithCachedPrimarySignature(db, ACCOUNT, emptyDraftInput())
      expect(draft.bodyHtml).toContain(
        '<div dir="ltr"><div><br></div><div><div dir="ltr" class="gmail_signature"'
      )
      expect(draft.bodyHtml).toContain('class="gmail_signature"')
      expect(draft.bodyHtml).toContain('Best,')
      expect(draft.bodyHtml).toContain('color:#123456')
      expect(draft.bodyHtml).not.toMatch(/position|script|alert/i)
      expect(draft.bodyText).toBe('\nBest,\nChao')
    } finally {
      db.close()
    }
  })

  it('uses the latest Gmail-sent name when the primary send-as name is empty', () => {
    const db = openDatabase(':memory:')
    try {
      db.prepare(
        `INSERT INTO messages
           (account_id, id, thread_id, from_name, from_email, internal_date, labels_json)
         VALUES (?, 'gmail-sent', 'thread-1', 'Chao Wu', ?, 10, '["SENT"]')`
      ).run(ACCOUNT, ACCOUNT)
      const insertAttnSent = db.prepare(
        `INSERT INTO messages
           (account_id, id, thread_id, from_name, from_email, internal_date, labels_json)
         VALUES (?, ?, ?, 'me', ?, ?, '["SENT"]')`
      )
      for (let index = 0; index < 25; index += 1) {
        insertAttnSent.run(ACCOUNT, `attn-sent-${index}`, `thread-${index + 2}`, ACCOUNT, 20 + index)
      }

      cachePrimarySendAs(db, ACCOUNT, { sendAsEmail: ACCOUNT, displayName: '', signature: '' })
      expect(readAccountSetting(db, ACCOUNT, SEND_AS_DISPLAY_NAME_SETTING)).toBe('Chao Wu')

      cachePrimarySendAs(db, ACCOUNT, {
        sendAsEmail: ACCOUNT,
        displayName: 'Updated Name',
        signature: ''
      })
      expect(readAccountSetting(db, ACCOUNT, SEND_AS_DISPLAY_NAME_SETTING)).toBe('Updated Name')
    } finally {
      db.close()
    }
  })

  it('rebuilds a legacy cached signature envelope without a Gmail settings change', () => {
    const db = openDatabase(':memory:')
    const source = '<div dir="ltr">Best,<div>Chao Wu</div></div>'
    try {
      writeAccountSetting(db, ACCOUNT, SEND_AS_SIGNATURE_SOURCE_SETTING, source)
      writeAccountSetting(
        db,
        ACCOUNT,
        SEND_AS_SIGNATURE_HTML_SETTING,
        `<div><br></div><div class="gmail_signature" data-smartmail="gmail_signature">${source}</div>`
      )
      writeAccountSetting(db, ACCOUNT, SEND_AS_SIGNATURE_TEXT_SETTING, '\nBest,\nChao Wu')

      const signature = cachePrimarySendAs(db, ACCOUNT, {
        sendAsEmail: ACCOUNT,
        signature: source
      })
      expect(signature.bodyHtml).toContain(
        '<div dir="ltr"><div><br></div><div><div dir="ltr" class="gmail_signature"'
      )
    } finally {
      db.close()
    }
  })

  it('adds the saved signature to every empty composer kind', () => {
    const db = openDatabase(':memory:')
    try {
      cachePrimarySendAs(db, ACCOUNT, { sendAsEmail: ACCOUNT, signature: '<div>Best,</div>' })
      for (const kind of ['new', 'reply', 'replyAll', 'forward'] as const) {
        expect(
          prepareDraftWithCachedPrimarySignature(db, ACCOUNT, {
            ...emptyDraftInput(),
            kind
          }).draft.bodyHtml
        ).toContain('Best,')
      }
      expect(
        prepareDraftWithCachedPrimarySignature(db, ACCOUNT, {
          ...emptyDraftInput(),
          bodyHtml: '<p>Existing</p>',
          bodyText: 'Existing'
        }).draft.bodyHtml
      ).toBe('<p>Existing</p>')

      cachePrimarySendAs(db, ACCOUNT, {
        sendAsEmail: ACCOUNT,
        signature: '<div class="gmail_signature">Nested marker</div>'
      })
      const nested = prepareDraftWithCachedPrimarySignature(db, ACCOUNT, emptyDraftInput())
      expect(hasOnlyDefaultPrimarySignature(nested.draft, nested.defaultSignatureFingerprint)).toBe(true)

      cachePrimarySendAs(db, ACCOUNT, {
        sendAsEmail: ACCOUNT,
        signature: '<ol><li>First</li><li>Second</li></ol>'
      })
      const listed = prepareDraftWithCachedPrimarySignature(db, ACCOUNT, emptyDraftInput())
      expect(
        hasOnlyDefaultPrimarySignature(
          { ...listed.draft, bodyText: '\n1. First\n2. Second' },
          listed.defaultSignatureFingerprint
        )
      ).toBe(true)
    } finally {
      db.close()
    }
  })

  it('recognizes the untouched signature after editor normalization', () => {
    const db = openDatabase(':memory:')
    try {
      cachePrimarySendAs(db, ACCOUNT, {
        sendAsEmail: ACCOUNT,
        signature: '<div style="color:#123456">Best,</div><div><a href="https://attn.test">Chao</a></div>'
      })
      const prepared = prepareDraftWithCachedPrimarySignature(db, ACCOUNT, emptyDraftInput())
      const normalized = {
        ...emptyDraftInput(),
        bodyHtml:
          '<p><br></p><div><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature"><p><span style="color: rgb(18, 52, 86)">Best,</span></p><p><a href="https://attn.test">Chao</a></p></div></div>',
        bodyText: '\nBest,\nChao'
      }
      expect(hasOnlyDefaultPrimarySignature(normalized, prepared.defaultSignatureFingerprint)).toBe(true)
      expect(
        hasOnlyDefaultPrimarySignature(
          {
            ...normalized,
            bodyHtml: normalized.bodyHtml.replace('https://attn.test', 'https://edited.test')
          },
          prepared.defaultSignatureFingerprint
        )
      ).toBe(false)
      expect(
        hasOnlyDefaultPrimarySignature(
          {
            ...normalized,
            bodyHtml: normalized.bodyHtml.replace(
              '<p><span style="color: rgb(18, 52, 86)">Best,</span></p>',
              '<ul><li><span style="color: rgb(18, 52, 86)">Best,</span></li></ul>'
            ),
            bodyText: '\n- Best,\nChao'
          },
          prepared.defaultSignatureFingerprint
        )
      ).toBe(false)
      expect(
        hasOnlyDefaultPrimarySignature(
          {
            ...normalized,
            bodyHtml: `<p>Authored</p>${normalized.bodyHtml}`,
            bodyText: `Authored\n${normalized.bodyText}`
          },
          prepared.defaultSignatureFingerprint
        )
      ).toBe(false)
      expect(
        hasOnlyDefaultPrimarySignature(
          {
            ...normalized,
            bodyHtml: normalized.bodyHtml.replace(
              '<span style="color: rgb(18, 52, 86)">Best,</span>',
              '<strong><span style="color: rgb(18, 52, 86)">Best,</span></strong>'
            )
          },
          prepared.defaultSignatureFingerprint
        )
      ).toBe(false)
    } finally {
      db.close()
    }
  })

  it('clears a cached signature when Gmail returns no signature', () => {
    const db = openDatabase(':memory:')
    try {
      cachePrimarySendAs(db, ACCOUNT, { sendAsEmail: ACCOUNT, signature: '<div>Old</div>' })
      cachePrimarySendAs(db, ACCOUNT, { sendAsEmail: ACCOUNT, signature: '' })
      expect(prepareDraftWithCachedPrimarySignature(db, ACCOUNT, emptyDraftInput()).draft.bodyHtml).toBe('')
    } finally {
      db.close()
    }
  })

  it('does not mirror or retain a new draft that contains only the default signature', () => {
    const db = openDatabase(':memory:')
    try {
      cachePrimarySendAs(db, ACCOUNT, { sendAsEmail: ACCOUNT, signature: '<div>Best,</div>' })
      const prepared = prepareDraftWithCachedPrimarySignature(db, ACCOUNT, emptyDraftInput())
      const id = saveDraft(db, ACCOUNT, prepared.draft, 10, prepared.defaultSignatureFingerprint)

      cachePrimarySendAs(db, ACCOUNT, { sendAsEmail: ACCOUNT, signature: '<div>Changed</div>' })

      expect(listDrafts(db, ACCOUNT)).toEqual([])
      expect(requestDraftMirror(db, ACCOUNT, id)).toBe(false)
      expect(closeDraft(db, ACCOUNT, id, 20)).toBe('discarded')
      expect(db.prepare('SELECT id FROM outbox WHERE id = ?').get(id)).toBeUndefined()
    } finally {
      db.close()
    }
  })

  it('does not mirror or retain an untouched reply or forward with the default signature', () => {
    const db = openDatabase(':memory:')
    try {
      cachePrimarySendAs(db, ACCOUNT, { sendAsEmail: ACCOUNT, signature: '<div>Best,</div>' })
      for (const kind of ['reply', 'forward'] as const) {
        const prepared = prepareDraftWithCachedPrimarySignature(db, ACCOUNT, {
          ...emptyDraftInput(),
          kind,
          to: kind === 'reply' ? [{ name: 'Maya', email: 'maya@example.com' }] : [],
          subject: kind === 'reply' ? 'Re: Design notes' : 'Fwd: Design notes',
          threadId: 'thread-1',
          sourceMessageId: 'message-1',
          quoteHtml: '<blockquote>Original</blockquote>',
          quoteText: '> Original'
        })
        const id = saveDraft(db, ACCOUNT, prepared.draft, 10, prepared.defaultSignatureFingerprint)

        cachePrimarySendAs(db, ACCOUNT, {
          sendAsEmail: ACCOUNT,
          signature: '<div>Changed</div>'
        })
        expect(requestDraftMirror(db, ACCOUNT, id)).toBe(false)
        expect(closeDraft(db, ACCOUNT, id, 20)).toBe('discarded')
      }
    } finally {
      db.close()
    }
  })
})

describe('optional "Sent with Attn" footer (F6/T32B)', () => {
  const enable = (db: ReturnType<typeof openDatabase>): void => {
    writeSetting(db, ACCOUNT, ATTN_SIGNATURE_SETTING, 'true')
  }

  it('is off by default and per-account', () => {
    const db = openDatabase(':memory:')
    try {
      cachePrimarySendAs(db, ACCOUNT, { sendAsEmail: ACCOUNT, signature: '<div>Best,</div>' })
      const prepared = prepareDraftWithCachedPrimarySignature(db, ACCOUNT, emptyDraftInput())
      expect(prepared.draft.bodyHtml).not.toContain(ATTN_SIGNATURE_LINE)

      writeSetting(db, 'other@example.com', ATTN_SIGNATURE_SETTING, 'true')
      const stillOff = prepareDraftWithCachedPrimarySignature(db, ACCOUNT, emptyDraftInput())
      expect(stillOff.draft.bodyHtml).not.toContain(ATTN_SIGNATURE_LINE)
    } finally {
      db.close()
    }
  })

  it('places the footer after the Gmail signature in every composer kind', () => {
    const db = openDatabase(':memory:')
    try {
      cachePrimarySendAs(db, ACCOUNT, { sendAsEmail: ACCOUNT, signature: '<div>Best,</div>' })
      enable(db)
      for (const kind of ['new', 'reply', 'replyAll', 'forward'] as const) {
        const { draft } = prepareDraftWithCachedPrimarySignature(db, ACCOUNT, {
          ...emptyDraftInput(),
          kind
        })
        const signatureAt = draft.bodyHtml.indexOf('gmail_signature')
        const footerAt = draft.bodyHtml.indexOf('data-attn-signature="footer"')
        expect(signatureAt).toBeGreaterThanOrEqual(0)
        expect(footerAt).toBeGreaterThan(signatureAt)
        expect(draft.bodyHtml.slice(footerAt)).toContain(`href="${ATTN_SIGNATURE_URL}"`)
        expect(draft.bodyHtml.slice(footerAt)).toContain('>Attn:</a>')
        expect(draft.bodyHtml.slice(footerAt)).not.toMatch(/<img\b/)
        expect(draft.bodyText.endsWith(`\n\n${ATTN_SIGNATURE_LINE}`)).toBe(true)
      }
      // The cached signature settings were not mutated by composition.
      expect(readAccountSetting(db, ACCOUNT, SEND_AS_SIGNATURE_HTML_SETTING)).not.toContain(
        ATTN_SIGNATURE_LINE
      )
    } finally {
      db.close()
    }
  })

  it('composes a footer-only body when no Gmail signature exists', () => {
    const db = openDatabase(':memory:')
    try {
      enable(db)
      const prepared = prepareDraftWithCachedPrimarySignature(db, ACCOUNT, emptyDraftInput())
      expect(prepared.draft.bodyHtml).toContain('data-attn-signature="footer"')
      expect(prepared.draft.bodyHtml.startsWith('<div dir="ltr"><div><br></div>')).toBe(true)
      expect(prepared.draft.bodyText).toBe(`\n\n${ATTN_SIGNATURE_LINE}`)
      expect(prepared.defaultSignatureFingerprint).not.toBeNull()
    } finally {
      db.close()
    }
  })

  it('reuses a signature that already carries the standalone line', () => {
    const db = openDatabase(':memory:')
    try {
      cachePrimarySendAs(db, ACCOUNT, {
        sendAsEmail: ACCOUNT,
        signature: `<div>Best,</div><div>${ATTN_SIGNATURE_LINE}</div>`
      })
      enable(db)
      const { draft } = prepareDraftWithCachedPrimarySignature(db, ACCOUNT, emptyDraftInput())
      expect(draft.bodyHtml).not.toContain('data-attn-signature')
      expect(draft.bodyHtml.split(ATTN_SIGNATURE_LINE)).toHaveLength(2)
    } finally {
      db.close()
    }
  })

  it('treats signature plus footer as one untouched baseline governed by the stored fingerprint', () => {
    const db = openDatabase(':memory:')
    try {
      cachePrimarySendAs(db, ACCOUNT, { sendAsEmail: ACCOUNT, signature: '<div>Best,</div>' })
      enable(db)
      const prepared = prepareDraftWithCachedPrimarySignature(db, ACCOUNT, emptyDraftInput())
      expect(hasOnlyDefaultPrimarySignature(prepared.draft, prepared.defaultSignatureFingerprint)).toBe(true)
      // Lexical-shaped normalization (rgb color, span layout) still matches.
      const normalized = {
        ...prepared.draft,
        bodyHtml: prepared.draft.bodyHtml.replace('color:#888888', 'color: rgb(136, 136, 136)')
      }
      expect(hasOnlyDefaultPrimarySignature(normalized, prepared.defaultSignatureFingerprint)).toBe(true)

      // Changing the preference or the cached signature afterwards does not
      // reclassify: the draft's own stored baseline governs.
      db.prepare('DELETE FROM settings WHERE account_id = ? AND key = ?').run(ACCOUNT, ATTN_SIGNATURE_SETTING)
      cachePrimarySendAs(db, ACCOUNT, { sendAsEmail: ACCOUNT, signature: '<div>Changed</div>' })
      expect(hasOnlyDefaultPrimarySignature(prepared.draft, prepared.defaultSignatureFingerprint)).toBe(true)

      // Editing or deleting the footer makes the draft authored content.
      expect(
        hasOnlyDefaultPrimarySignature(
          {
            ...prepared.draft,
            bodyHtml: prepared.draft.bodyHtml.replace('Attn:</a>', 'love</a>')
          },
          prepared.defaultSignatureFingerprint
        )
      ).toBe(false)
      const withoutFooter = prepared.draft.bodyHtml.replace(
        /<div data-attn-signature="footer">.*?<\/div>/,
        ''
      )
      expect(
        hasOnlyDefaultPrimarySignature(
          { ...prepared.draft, bodyHtml: withoutFooter },
          prepared.defaultSignatureFingerprint
        )
      ).toBe(false)
    } finally {
      db.close()
    }
  })

  it('does not mirror or retain untouched footer drafts, with or without a signature', () => {
    const db = openDatabase(':memory:')
    try {
      enable(db)
      for (const signature of ['', '<div>Best,</div>']) {
        cachePrimarySendAs(db, ACCOUNT, { sendAsEmail: ACCOUNT, signature })
        const prepared = prepareDraftWithCachedPrimarySignature(db, ACCOUNT, {
          ...emptyDraftInput(),
          kind: 'reply',
          to: [{ name: 'Maya', email: 'maya@example.com' }],
          subject: 'Re: Design notes',
          threadId: 'thread-1',
          sourceMessageId: 'message-1',
          quoteHtml: '<blockquote>Original</blockquote>',
          quoteText: '> Original'
        })
        const id = saveDraft(db, ACCOUNT, prepared.draft, 10, prepared.defaultSignatureFingerprint)
        expect(requestDraftMirror(db, ACCOUNT, id)).toBe(false)
        expect(closeDraft(db, ACCOUNT, id, 20)).toBe('discarded')
      }
      // A footer-only *new* draft is effectively empty: hidden from Drafts,
      // never mirrored, discarded on close.
      const blank = prepareDraftWithCachedPrimarySignature(db, ACCOUNT, emptyDraftInput())
      const blankId = saveDraft(db, ACCOUNT, blank.draft, 10, blank.defaultSignatureFingerprint)
      expect(listDrafts(db, ACCOUNT)).toEqual([])
      expect(requestDraftMirror(db, ACCOUNT, blankId)).toBe(false)
      expect(closeDraft(db, ACCOUNT, blankId, 20)).toBe('discarded')
    } finally {
      db.close()
    }
  })

  it('keeps old signature-only fingerprints working after the footer ships', () => {
    const db = openDatabase(':memory:')
    try {
      cachePrimarySendAs(db, ACCOUNT, { sendAsEmail: ACCOUNT, signature: '<div>Best,</div>' })
      const before = prepareDraftWithCachedPrimarySignature(db, ACCOUNT, emptyDraftInput())
      // The preference flips on later; the pre-footer draft still reads as
      // untouched against its own stored fingerprint.
      enable(db)
      expect(hasOnlyDefaultPrimarySignature(before.draft, before.defaultSignatureFingerprint)).toBe(true)
    } finally {
      db.close()
    }
  })
})
