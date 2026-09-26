import { expect, it, vi } from 'vitest'
import { emptyDraftInput } from '../../shared/drafts'
import { openDatabase } from '../db'
import { fakeMailProvider } from '../testing/fakes'
import { encodeDraftMessage } from './draftMime'
import { draftContentFingerprint } from './draftSync'
import { closeDraft, getDraft, reopenDraft, requestDraftMirror, saveDraft } from './drafts'
import { queueSend, undoQueuedSend } from './queue'
import {
  cacheSendAsIdentities,
  prepareDraftWithCachedPrimarySignature,
  publicSendAsIdentities,
  resolveSendAs,
  syncPrimarySendAs
} from './sendAs'
import { OutboxSender } from './sender'

const ACCOUNT = 'me@example.com'
const ALIAS = 'work@example.org'
const identities = [
  { sendAsEmail: ACCOUNT, isPrimary: true },
  {
    sendAsEmail: ALIAS,
    displayName: 'Work Name',
    replyToAddress: 'reply@example.org',
    isDefault: true,
    verificationStatus: 'accepted',
    signature: '<b>Work signature</b><script>bad()</script>'
  },
  { sendAsEmail: 'pending@example.org', verificationStatus: 'pending' }
]

it('caches only verified identities, strips private fields, and isolates accounts', async () => {
  const db = openDatabase(':memory:')
  try {
    await syncPrimarySendAs(db, ACCOUNT, { listSendAs: async () => identities })
    expect(publicSendAsIdentities(db, ACCOUNT).map((identity) => identity.sendAsEmail)).toEqual([
      ACCOUNT,
      ALIAS
    ])
    expect(publicSendAsIdentities(db, ACCOUNT)[1]).not.toHaveProperty('signature')
    expect(() => resolveSendAs(db, 'other@example.com', ALIAS)).toThrow('no longer available')
    const prepared = prepareDraftWithCachedPrimarySignature(db, ACCOUNT, emptyDraftInput())
    expect(prepared.draft.senderEmail).toBe(ALIAS)
    expect(prepared.draft.bodyHtml).toContain('Work signature')
    expect(prepared.draft.bodyHtml).not.toContain('<script>')
  } finally {
    db.close()
  }
})

it('retains the sender through saving, reopening, and undo, and rejects a removed alias', () => {
  const db = openDatabase(':memory:')
  try {
    cacheSendAsIdentities(db, ACCOUNT, identities)
    const id = saveDraft(db, ACCOUNT, {
      ...emptyDraftInput(),
      senderEmail: ALIAS,
      to: [{ name: '', email: 'you@example.com' }],
      bodyText: 'hello'
    })
    closeDraft(db, ACCOUNT, id)
    expect(reopenDraft(db, ACCOUNT, id)?.senderEmail).toBe(ALIAS)
    queueSend(db, ACCOUNT, id)
    undoQueuedSend(db, ACCOUNT, id)
    expect(getDraft(db, ACCOUNT, id)?.senderEmail).toBe(ALIAS)
    expect(getDraft(db, 'other@example.com', id)).toBeNull()
    cacheSendAsIdentities(db, ACCOUNT, [])
    expect(() => queueSend(db, ACCOUNT, id)).toThrow('no longer available')
  } finally {
    db.close()
  }
})

it('includes the sender in mirrored MIME and conflict detection', () => {
  const input = { ...emptyDraftInput(), senderEmail: ALIAS }
  expect(Buffer.from(encodeDraftMessage({ ...input, attachments: [] }), 'base64url').toString()).toContain(
    `From: ${ALIAS}`
  )
  expect(draftContentFingerprint(input)).not.toBe(draftContentFingerprint({ ...input, senderEmail: ACCOUNT }))
})

it('sends with the selected name and Reply-To through Gmail', async () => {
  const db = openDatabase(':memory:')
  try {
    cacheSendAsIdentities(db, ACCOUNT, identities)
    const id = saveDraft(db, ACCOUNT, {
      ...emptyDraftInput(),
      senderEmail: ALIAS,
      to: [{ name: '', email: 'you@example.com' }],
      bodyText: 'hello'
    })
    db.prepare(
      "UPDATE outbox SET state = 'queued', rfc_message_id = '<test@example.com>', send_at = 0 WHERE id = ?"
    ).run(id)
    const createDraft = vi.fn(async ({ raw }: { raw: string }) => {
      const mime = Buffer.from(raw, 'base64url').toString()
      expect(mime).toContain(`From: Work Name <${ALIAS}>`)
      expect(mime).toContain('Reply-To: reply@example.org')
      return 'remote-draft'
    })
    const provider = fakeMailProvider({
      listSendAs: async () => identities,
      createDraft,
      sendDraft: async () => ({ id: 'sent', threadId: '' })
    })
    const sender = new OutboxSender(
      db,
      () => ACCOUNT,
      () => provider,
      () => {}
    )
    await sender.trigger()
    await sender.stop()
    expect(createDraft).toHaveBeenCalledOnce()
    expect(db.prepare('SELECT state FROM outbox WHERE id = ?').get(id)).toEqual({ state: 'sent' })
  } finally {
    db.close()
  }
})

it('imports and updates a Gmail draft sender without rebinding its account', async () => {
  const { reconcileRemoteDraft } = await import('./draftSync')
  const db = openDatabase(':memory:')
  try {
    const remote = (email: string) => ({
      id: 'gmail-draft',
      message: {
        id: 'gmail-message',
        threadId: 'gmail-thread',
        labelIds: ['DRAFT'],
        payload: {
          mimeType: 'text/plain',
          headers: [
            { name: 'From', value: email },
            { name: 'Subject', value: 'Remote draft' }
          ],
          body: { data: Buffer.from('Remote content').toString('base64url') }
        }
      }
    })
    await reconcileRemoteDraft(db, ACCOUNT, remote(ALIAS))
    expect(db.prepare('SELECT account_id, sender_email FROM outbox').get()).toEqual({
      account_id: ACCOUNT,
      sender_email: ALIAS
    })
    await reconcileRemoteDraft(db, ACCOUNT, remote(ACCOUNT))
    expect(db.prepare('SELECT account_id, sender_email FROM outbox').get()).toEqual({
      account_id: ACCOUNT,
      sender_email: null
    })
  } finally {
    db.close()
  }
})

it('fails before remote mutation when Gmail revokes the selected identity', async () => {
  const db = openDatabase(':memory:')
  try {
    cacheSendAsIdentities(db, ACCOUNT, identities)
    const id = saveDraft(db, ACCOUNT, {
      ...emptyDraftInput(),
      senderEmail: ALIAS,
      to: [{ name: '', email: 'you@example.com' }],
      bodyText: 'hello'
    })
    db.prepare(
      "UPDATE outbox SET state = 'queued', rfc_message_id = '<test@example.com>', send_at = 0 WHERE id = ?"
    ).run(id)
    const createDraft = vi.fn(async () => 'unexpected')
    const sendDraft = vi.fn(async () => ({ id: 'unexpected', threadId: '' }))
    const provider = fakeMailProvider({ listSendAs: async () => [identities[0]], createDraft, sendDraft })
    const sender = new OutboxSender(
      db,
      () => ACCOUNT,
      () => provider,
      () => {}
    )
    await sender.trigger()
    await sender.stop()
    expect(createDraft).not.toHaveBeenCalled()
    expect(sendDraft).not.toHaveBeenCalled()
    expect(db.prepare('SELECT state, sender_email FROM outbox WHERE id = ?').get(id)).toEqual({
      state: 'failed',
      sender_email: ALIAS
    })
  } finally {
    db.close()
  }
})

for (const recoveredDraft of ['known-draft', null]) {
  it(`recovers an alias send with ${recoveredDraft ?? 'an orphaned draft'} without changing From`, async () => {
    const db = openDatabase(':memory:')
    try {
      cacheSendAsIdentities(db, ACCOUNT, identities)
      const id = saveDraft(db, ACCOUNT, {
        ...emptyDraftInput(),
        senderEmail: ALIAS,
        to: [{ name: '', email: 'you@example.com' }],
        bodyText: 'Recover me'
      })
      db.prepare(
        "UPDATE outbox SET state = 'sending', gmail_draft_id = ?, rfc_message_id = '<recover@example.com>', send_at = 0 WHERE id = ?"
      ).run(recoveredDraft, id)
      const createDraft = vi.fn(async () => 'unexpected')
      const updateDraft = vi.fn(async (draft: { id: string; raw?: string }) => {
        expect(Buffer.from(draft.raw ?? '', 'base64url').toString()).toContain(`From: Work Name <${ALIAS}>`)
        return draft.id
      })
      const sendDraft = vi.fn(async () => ({ id: 'sent', threadId: '' }))
      const provider = fakeMailProvider({
        listSendAs: async () => identities,
        createDraft,
        updateDraft,
        sendDraft,
        findByRfcId: async () => ({ kind: 'draft', draftId: 'orphaned-draft', messageId: 'orphaned-message' })
      })
      const sender = new OutboxSender(
        db,
        () => ACCOUNT,
        () => provider,
        () => {}
      )
      await sender.trigger()
      await sender.stop()
      expect(createDraft).not.toHaveBeenCalled()
      expect(updateDraft).toHaveBeenCalledOnce()
      expect(sendDraft).toHaveBeenCalledWith(recoveredDraft ?? 'orphaned-draft', expect.anything())
      expect(db.prepare('SELECT state, sender_email FROM outbox WHERE id = ?').get(id)).toEqual({
        state: 'sent',
        sender_email: ALIAS
      })
    } finally {
      db.close()
    }
  })
}

it('mirrors sender edits through the production drain and reconciles the Gmail echo', async () => {
  const { drainDraftMirrors } = await import('./mirror')
  const { reconcileRemoteDraft } = await import('./draftSync')
  const db = openDatabase(':memory:')
  try {
    const input = {
      ...emptyDraftInput(),
      to: [{ name: 'you', email: 'you@example.com' }],
      subject: 'Mirror',
      bodyHtml: '<p>Hello</p>'
    }
    const id = saveDraft(db, ACCOUNT, input)
    const createDraft = vi.fn(async ({ raw }: { raw: string }) => {
      expect(Buffer.from(raw, 'base64url').toString()).toContain(`From: ${ACCOUNT}`)
      return 'remote-draft'
    })
    const updateDraft = vi.fn(async (draft: { id: string; raw?: string }) => {
      expect(Buffer.from(draft.raw ?? '', 'base64url').toString()).toContain(`From: ${ALIAS}`)
      return draft.id
    })
    const provider = fakeMailProvider({ createDraft, updateDraft })
    await drainDraftMirrors(db, ACCOUNT, provider)
    saveDraft(db, ACCOUNT, { ...input, id, senderEmail: ALIAS })
    await drainDraftMirrors(db, ACCOUNT, provider)
    closeDraft(db, ACCOUNT, id)
    const decision = await reconcileRemoteDraft(db, ACCOUNT, {
      id: 'remote-draft',
      message: {
        id: 'gmail-message',
        threadId: 'gmail-thread',
        labelIds: ['DRAFT'],
        payload: {
          mimeType: 'text/html',
          headers: [
            { name: 'From', value: ALIAS },
            { name: 'To', value: 'you@example.com' },
            { name: 'Subject', value: 'Mirror' }
          ],
          body: { data: Buffer.from('<p>Hello</p>').toString('base64url') }
        }
      }
    })
    expect(decision).toBe('local')
    expect(reopenDraft(db, ACCOUNT, id)?.senderEmail).toBe(ALIAS)
    expect(createDraft).toHaveBeenCalledOnce()
    expect(updateDraft).toHaveBeenCalledOnce()
    expect(db.prepare('SELECT count(*) AS total FROM outbox').get()).toEqual({ total: 1 })
  } finally {
    db.close()
  }
})

it.each(['reply', 'replyAll'] as const)(
  'keeps a sender-only %s edit eligible for sync and reopen',
  (kind) => {
    const db = openDatabase(':memory:')
    try {
      const input = {
        ...emptyDraftInput(),
        kind,
        senderEmail: ACCOUNT,
        to: [{ name: 'Maya', email: 'maya@example.com' }],
        subject: 'Re: Project',
        threadId: 'thread',
        quoteText: '> Original'
      }
      const untouched = saveDraft(db, ACCOUNT, input)
      expect(requestDraftMirror(db, ACCOUNT, untouched)).toBe(false)
      expect(closeDraft(db, ACCOUNT, untouched)).toBe('discarded')
      const id = saveDraft(db, ACCOUNT, input)
      saveDraft(db, ACCOUNT, { ...input, id, senderEmail: ALIAS })
      expect(requestDraftMirror(db, ACCOUNT, id)).toBe(true)
      expect(closeDraft(db, ACCOUNT, id)).toBe('saved')
      expect(reopenDraft(db, ACCOUNT, id)?.senderEmail).toBe(ALIAS)
      saveDraft(db, ACCOUNT, { ...input, id })
      expect(closeDraft(db, ACCOUNT, id)).toBe('saved')
      expect(reopenDraft(db, ACCOUNT, id)?.senderEmail ?? ACCOUNT).toBe(ACCOUNT)
    } finally {
      db.close()
    }
  }
)

it('uses the refreshed primary Reply-To on the first send without an identity cache', async () => {
  const db = openDatabase(':memory:')
  try {
    const id = saveDraft(db, ACCOUNT, {
      ...emptyDraftInput(),
      to: [{ name: '', email: 'you@example.com' }],
      bodyText: 'hello'
    })
    db.prepare(
      "UPDATE outbox SET state = 'queued', rfc_message_id = '<first-primary@example.com>', send_at = 0 WHERE id = ?"
    ).run(id)
    const primary = {
      sendAsEmail: ACCOUNT,
      isPrimary: true,
      displayName: 'Primary Name',
      replyToAddress: 'reply@example.org'
    }
    const createDraft = vi.fn(async ({ raw }: { raw: string }) => {
      const mime = Buffer.from(raw, 'base64url').toString()
      expect(mime).toContain(`From: Primary Name <${ACCOUNT}>`)
      expect(mime).toContain('Reply-To: reply@example.org')
      return 'primary-draft'
    })
    const provider = fakeMailProvider({
      getSendAs: async () => primary,
      listSendAs: async () => [primary],
      createDraft,
      sendDraft: async () => ({ id: 'sent', threadId: '' })
    })
    const sender = new OutboxSender(
      db,
      () => ACCOUNT,
      () => provider,
      () => {}
    )
    await sender.trigger()
    await sender.stop()
    expect(createDraft).toHaveBeenCalledOnce()
    expect(db.prepare('SELECT state FROM outbox WHERE id = ?').get(id)).toEqual({ state: 'sent' })
  } finally {
    db.close()
  }
})
