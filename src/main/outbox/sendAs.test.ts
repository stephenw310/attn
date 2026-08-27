import { describe, expect, it, vi } from 'vitest'
import { emptyDraftInput } from '../../shared/drafts'
import { openDatabase } from '../db'
import { readAccountSetting } from '../settings'
import { closeDraft, listDrafts, requestDraftMirror, saveDraft } from './drafts'
import {
  applyCachedPrimarySignature,
  cachePrimarySendAs,
  hasOnlyCachedPrimarySignature,
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
      const draft = applyCachedPrimarySignature(db, ACCOUNT, emptyDraftInput())
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
      expect(applyCachedPrimarySignature(db, ACCOUNT, emptyDraftInput()).bodyHtml).toContain('Best,')
      expect(
        applyCachedPrimarySignature(db, ACCOUNT, {
          ...emptyDraftInput(),
          kind: 'reply'
        }).bodyHtml
      ).toBe('')
      expect(
        applyCachedPrimarySignature(db, ACCOUNT, {
          ...emptyDraftInput(),
          bodyHtml: '<p>Existing</p>',
          bodyText: 'Existing'
        }).bodyHtml
      ).toBe('<p>Existing</p>')

      cachePrimarySendAs(db, ACCOUNT, {
        sendAsEmail: ACCOUNT,
        signature: '<div class="gmail_signature">Nested marker</div>'
      })
      const nested = applyCachedPrimarySignature(db, ACCOUNT, emptyDraftInput())
      expect(hasOnlyCachedPrimarySignature(db, ACCOUNT, nested)).toBe(true)

      cachePrimarySendAs(db, ACCOUNT, {
        sendAsEmail: ACCOUNT,
        signature: '<ol><li>First</li><li>Second</li></ol>'
      })
      const listed = applyCachedPrimarySignature(db, ACCOUNT, emptyDraftInput())
      expect(
        hasOnlyCachedPrimarySignature(db, ACCOUNT, {
          ...listed,
          bodyText: '\n1. First\n2. Second'
        })
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
      const normalized = {
        ...emptyDraftInput(),
        bodyHtml:
          '<p><br></p><div class="gmail_signature" data-smartmail="gmail_signature"><p><span style="color: rgb(18, 52, 86)">Best,</span></p><p><a href="https://attn.test">Chao</a></p></div>',
        bodyText: '\nBest,\nChao'
      }
      expect(hasOnlyCachedPrimarySignature(db, ACCOUNT, normalized)).toBe(true)
      expect(
        hasOnlyCachedPrimarySignature(db, ACCOUNT, {
          ...normalized,
          bodyHtml: normalized.bodyHtml.replace('https://attn.test', 'https://edited.test')
        })
      ).toBe(false)
      expect(
        hasOnlyCachedPrimarySignature(db, ACCOUNT, {
          ...normalized,
          bodyHtml: normalized.bodyHtml.replace(
            '<p><span style="color: rgb(18, 52, 86)">Best,</span></p>',
            '<ul><li><span style="color: rgb(18, 52, 86)">Best,</span></li></ul>'
          ),
          bodyText: '\n- Best,\nChao'
        })
      ).toBe(false)
      expect(
        hasOnlyCachedPrimarySignature(db, ACCOUNT, {
          ...normalized,
          bodyHtml: `<p>Authored</p>${normalized.bodyHtml}`,
          bodyText: `Authored\n${normalized.bodyText}`
        })
      ).toBe(false)
      expect(
        hasOnlyCachedPrimarySignature(db, ACCOUNT, {
          ...normalized,
          bodyHtml: normalized.bodyHtml.replace(
            '<span style="color: rgb(18, 52, 86)">Best,</span>',
            '<strong><span style="color: rgb(18, 52, 86)">Best,</span></strong>'
          )
        })
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
      expect(applyCachedPrimarySignature(db, ACCOUNT, emptyDraftInput()).bodyHtml).toBe('')
    } finally {
      db.close()
    }
  })

  it('does not mirror or retain a new draft that contains only the default signature', () => {
    const db = openDatabase(':memory:')
    try {
      cachePrimarySendAs(db, ACCOUNT, { sendAsEmail: ACCOUNT, signature: '<div>Best,</div>' })
      const input = applyCachedPrimarySignature(db, ACCOUNT, emptyDraftInput())
      const id = saveDraft(db, ACCOUNT, input, 10)

      expect(listDrafts(db, ACCOUNT)).toEqual([])
      expect(requestDraftMirror(db, ACCOUNT, id)).toBe(false)
      expect(closeDraft(db, ACCOUNT, id, 20)).toBe('discarded')
      expect(db.prepare('SELECT id FROM outbox WHERE id = ?').get(id)).toBeUndefined()
    } finally {
      db.close()
    }
  })
})
