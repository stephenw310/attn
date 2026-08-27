import { describe, expect, it, vi } from 'vitest'
import { emptyDraftInput } from '../../shared/drafts'
import { openDatabase } from '../db'
import { readAccountSetting } from '../settings'
import { closeDraft, listDrafts, requestDraftMirror, saveDraft } from './drafts'
import {
  cachePrimarySendAs,
  hasOnlyDefaultPrimarySignature,
  prepareDraftWithCachedPrimarySignature,
  SEND_AS_DISPLAY_NAME_SETTING,
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
      expect(draft.bodyHtml).toContain('class="gmail_signature"')
      expect(draft.bodyHtml).toContain('Best,')
      expect(draft.bodyHtml).toContain('color:#123456')
      expect(draft.bodyHtml).not.toMatch(/position|script|alert/i)
      expect(draft.bodyText).toBe('\nBest,\nChao')
    } finally {
      db.close()
    }
  })

  it('adds the saved signature only to an empty new message', () => {
    const db = openDatabase(':memory:')
    try {
      cachePrimarySendAs(db, ACCOUNT, { sendAsEmail: ACCOUNT, signature: '<div>Best,</div>' })
      expect(prepareDraftWithCachedPrimarySignature(db, ACCOUNT, emptyDraftInput()).draft.bodyHtml).toContain(
        'Best,'
      )
      expect(
        prepareDraftWithCachedPrimarySignature(db, ACCOUNT, {
          ...emptyDraftInput(),
          kind: 'reply'
        }).draft.bodyHtml
      ).toBe('')
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
          '<p><br></p><div class="gmail_signature" data-smartmail="gmail_signature"><p><span style="color: rgb(18, 52, 86)">Best,</span></p><p><a href="https://attn.test">Chao</a></p></div>',
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
})
