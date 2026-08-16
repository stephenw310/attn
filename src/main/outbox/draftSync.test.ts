import { describe, expect, it, vi } from 'vitest'
import { emptyDraftInput } from '../../shared/drafts'
import type { Db } from '../db'
import type { GmailPart } from '../gmail/parse'
import type { MailActionProvider, ProviderDraft } from '../sync/provider'
import type { StoredDraftAttachment } from './draftAttachments'
import {
  draftContentFingerprint,
  parseRemoteDraft,
  planDraftConflict,
  reconcileRemoteDraft,
  remoteDraftKind,
  syncRemoteDrafts
} from './draftSync'
import { loadDraftMimeAttachments } from './mirror'

describe('draft conflict planning', () => {
  const base = {
    state: 'drafted' as const,
    localRevision: 2,
    mirrorRevision: 2,
    localUpdatedAt: 100,
    remoteUpdatedAt: 200,
    remoteChanged: true
  }

  it('takes a remote-only edit without consulting clocks', () => {
    expect(planDraftConflict({ ...base, remoteUpdatedAt: 1 })).toBe('remote')
  })

  it('keeps a local-only edit and uses timestamps only when both sides changed', () => {
    expect(planDraftConflict({ ...base, localRevision: 3, remoteChanged: false })).toBe('local')
    expect(planDraftConflict({ ...base, localRevision: 3, remoteUpdatedAt: 99 })).toBe('local')
    expect(planDraftConflict({ ...base, localRevision: 3, remoteUpdatedAt: 101 })).toBe('remote')
  })

  it('never rewrites an open composer', () => {
    expect(planDraftConflict({ ...base, state: 'composing' })).toBe('defer')
  })
})

function providerDraft(
  subject: string,
  body: GmailPart,
  headers: { name: string; value: string }[] = []
): ProviderDraft {
  return {
    id: 'draft-1',
    message: {
      id: 'message-1',
      threadId: 'thread-1',
      internalDate: '100',
      payload: {
        mimeType: 'multipart/alternative',
        headers: [{ name: 'Subject', value: subject }, { name: 'To', value: 'to@example.com' }, ...headers],
        parts: [body]
      }
    }
  }
}

function emptyLookupDb(): Db {
  return {
    prepare: vi.fn(() => ({ get: vi.fn(() => undefined) }))
  } as unknown as Db
}

function knownThreadLookupDb(): Db {
  return {
    prepare: vi.fn((sql: string) => ({
      get: vi.fn(() => (sql.includes('SELECT 1 FROM threads') ? { found: 1 } : undefined))
    }))
  } as unknown as Db
}

describe('remote draft parsing', () => {
  it('retains a text/plain-only draft body', async () => {
    const remote = providerDraft('Plain', {
      mimeType: 'text/plain',
      body: { data: Buffer.from('Keep this text').toString('base64url') }
    })
    const parsed = await parseRemoteDraft(emptyLookupDb(), 'account', remote, null, 200)

    expect(parsed.input.bodyHtml).toBe('')
    expect(parsed.input.bodyText).toBe('Keep this text')
  })

  it('fetches a large out-of-line HTML body before reconciliation', async () => {
    const remote = providerDraft('Large', {
      mimeType: 'text/html',
      body: { attachmentId: 'body-part', size: 100_000 }
    })
    const provider = {
      getAttachmentData: vi.fn(async () => Buffer.from('<p>Large body</p>').toString('base64url'))
    }
    const parsed = await parseRemoteDraft(emptyLookupDb(), 'account', remote, provider, 200)

    expect(provider.getAttachmentData).toHaveBeenCalledWith('message-1', 'body-part')
    expect(parsed.input.bodyHtml).toBe('<p>Large body</p>')
    expect(parsed.input.bodyText).toBe('Large body')
  })

  it('does not infer forwarding from user-authored subject text', () => {
    expect(remoteDraftKind(providerDraft('Fwd: still a new draft', { mimeType: 'text/plain' }))).toBe('new')
    expect(remoteDraftKind(providerDraft('Anything', { mimeType: 'text/plain' }), 'replyAll')).toBe(
      'replyAll'
    )
  })

  it('binds Gmail drafts whose authoritative thread already exists locally', async () => {
    const forward = await parseRemoteDraft(
      knownThreadLookupDb(),
      'account',
      providerDraft('Fwd: Existing conversation', { mimeType: 'text/plain' }),
      null,
      200
    )
    const reply = await parseRemoteDraft(
      knownThreadLookupDb(),
      'account',
      providerDraft('Existing conversation', { mimeType: 'text/plain' }, [
        { name: 'In-Reply-To', value: '<original@example.com>' }
      ]),
      null,
      200
    )

    expect(forward.input).toMatchObject({ kind: 'forward', threadId: 'thread-1' })
    expect(reply.input).toMatchObject({ kind: 'reply', threadId: 'thread-1' })
  })

  it('classifies localized forward subjects from threading headers instead of English text', () => {
    for (const subject of ['WG: Vorhandene Unterhaltung', 'TR: Conversation existante', 'Rv: Conversación']) {
      expect(remoteDraftKind(providerDraft(subject, { mimeType: 'text/plain' }), undefined, true)).toBe(
        'forward'
      )
    }
  })
})

describe('draft synchronization identity', () => {
  it('fingerprints canonical HTML instead of non-round-tripping editor plain text', () => {
    const base = {
      ...emptyDraftInput(),
      to: [{ name: '', email: 'to@example.com' }],
      bodyHtml: '<ul><li>One</li></ul>'
    }
    expect(draftContentFingerprint({ ...base, bodyText: '- One' })).toBe(
      draftContentFingerprint({ ...base, bodyText: 'One' })
    )
    expect(draftContentFingerprint({ ...base, bodyHtml: '', bodyText: 'Plain body' })).toBe(
      draftContentFingerprint({ ...base, bodyHtml: '<p>Plain body</p>', bodyText: 'Plain body' })
    )
  })

  it('does not fetch a draft whose Gmail message id is unchanged', async () => {
    const getDraft = vi.fn()
    const provider = {
      listDrafts: vi.fn(async () => ({ drafts: [{ id: 'draft-1', messageId: 'message-1' }] })),
      getDraft
    }
    const db = {
      prepare: vi.fn((sql: string) => ({
        all: vi.fn(() =>
          sql.includes('gmail_message_id')
            ? [{ gmail_draft_id: 'draft-1', gmail_message_id: 'message-1' }]
            : [
                {
                  id: 'local-1',
                  state: 'drafted',
                  gmail_draft_id: 'draft-1',
                  local_revision: 1,
                  mirror_revision: 1
                }
              ]
        )
      }))
    } as unknown as Db

    await expect(syncRemoteDrafts(db, 'account', provider as never)).resolves.toBe(false)
    expect(getDraft).not.toHaveBeenCalled()
  })

  it('refetches an unchanged legacy draft once to repair its missing thread binding', async () => {
    const remote = providerDraft('Fwd: Existing conversation', {
      mimeType: 'text/plain',
      body: { data: Buffer.from('Forward body').toString('base64url') }
    })
    const writeRemote = vi.fn()
    let localKind = 'new'
    let localThreadId: string | null = null
    const repairBinding = vi.fn((kind: string, threadId: string) => {
      localKind = kind
      localThreadId = threadId
      return { changes: 1 }
    })
    const db = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes('SELECT gmail_draft_id, gmail_message_id, kind, thread_id')) {
          return {
            all: vi.fn(() => [
              {
                gmail_draft_id: 'draft-1',
                gmail_message_id: 'message-1',
                kind: localKind,
                thread_id: localThreadId
              }
            ])
          }
        }
        if (sql.includes('SELECT kind, thread_id FROM outbox')) {
          return { get: vi.fn(() => ({ kind: 'new', thread_id: null })) }
        }
        if (sql.includes('SELECT 1 FROM threads')) return { get: vi.fn(() => ({ found: 1 })) }
        if (sql.includes('SELECT id, state, kind') && sql.includes('gmail_draft_id = ?')) {
          return {
            get: vi.fn(() => ({
              id: 'local-draft',
              state: 'drafted',
              kind: 'new',
              local_revision: 1,
              mirror_revision: 1,
              updated_at: 100,
              remote_fingerprint: 'legacy-unbound-fingerprint',
              attachments_json: '[]',
              thread_id: localThreadId
            }))
          }
        }
        if (sql.includes('UPDATE outbox SET kind = ?')) return { run: repairBinding }
        if (sql.includes('INSERT INTO outbox')) return { run: writeRemote }
        if (sql.includes('SELECT id, state, gmail_draft_id, local_revision')) {
          return {
            all: vi.fn(() => [
              {
                id: 'local-draft',
                state: 'drafted',
                gmail_draft_id: 'draft-1',
                local_revision: 2,
                mirror_revision: 2
              }
            ])
          }
        }
        throw new Error(`unexpected SQL: ${sql}`)
      })
    } as unknown as Db
    const getDraft = vi.fn(async () => remote)
    const provider = {
      listDrafts: vi.fn(async () => ({
        drafts: [{ id: 'draft-1', messageId: 'message-1', threadId: 'thread-1' }]
      })),
      getDraft
    }

    await expect(syncRemoteDrafts(db, 'account', provider as never)).resolves.toBe(true)
    await expect(syncRemoteDrafts(db, 'account', provider as never)).resolves.toBe(false)
    expect(getDraft).toHaveBeenCalledWith('draft-1')
    expect(getDraft).toHaveBeenCalledTimes(1)
    expect(repairBinding).toHaveBeenCalledWith('forward', 'thread-1', 'account', 'local-draft')
    expect(writeRemote.mock.calls[0]?.[4]).toBe('forward')
    expect(writeRemote.mock.calls[0]?.[12]).toBe('thread-1')
  })

  it('refreshes remote attachment locators when Gmail replaces the draft message', async () => {
    const remote: ProviderDraft = {
      id: 'draft-with-attachment',
      message: {
        id: 'message-new',
        threadId: 'thread-new',
        internalDate: '200',
        payload: {
          mimeType: 'multipart/mixed',
          headers: [
            { name: 'Subject', value: 'Attachment draft' },
            { name: 'To', value: 'to@example.com' }
          ],
          parts: [
            {
              mimeType: 'text/plain',
              body: { data: Buffer.from('Body').toString('base64url') }
            },
            {
              partId: 'part-new',
              mimeType: 'application/pdf',
              filename: 'notes.pdf',
              body: { attachmentId: 'attachment-new', size: 4 }
            }
          ]
        }
      }
    }
    const parsed = await parseRemoteDraft(emptyLookupDb(), 'account', remote, null, 300)
    const previous: StoredDraftAttachment = {
      id: 'stable-local-id',
      filename: 'notes.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 4,
      spoolPath: '',
      remoteMessageId: 'message-old',
      remoteAttachmentId: 'attachment-old'
    }
    const update = vi.fn((..._args: unknown[]) => ({ changes: 1 }))
    const db = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes('SELECT kind, thread_id')) {
          return { get: vi.fn(() => ({ kind: 'new', thread_id: null })) }
        }
        if (sql.includes('SELECT 1 FROM threads')) return { get: vi.fn(() => undefined) }
        if (sql.includes('SELECT id, state, kind')) {
          return {
            get: vi.fn(() => ({
              id: 'local-draft',
              state: 'drafted',
              kind: 'new',
              local_revision: 1,
              mirror_revision: 1,
              updated_at: 100,
              remote_fingerprint: parsed.fingerprint,
              attachments_json: JSON.stringify([previous])
            }))
          }
        }
        if (sql.includes('UPDATE outbox SET gmail_draft_id')) return { run: update }
        throw new Error(`unexpected SQL: ${sql}`)
      })
    } as unknown as Db

    await expect(reconcileRemoteDraft(db, 'account', remote, null, 300)).resolves.toBe('local')

    const refreshed = JSON.parse(String(update.mock.calls[0]?.[2])) as StoredDraftAttachment[]
    expect(refreshed).toEqual([
      expect.objectContaining({
        id: 'stable-local-id',
        remoteMessageId: 'message-new',
        remoteAttachmentId: 'attachment-new'
      })
    ])
    const getAttachmentData = vi.fn(async (_messageId: string, _attachmentId: string) =>
      Buffer.from('data').toString('base64url')
    )
    await loadDraftMimeAttachments(
      'local-draft',
      refreshed,
      { getAttachmentData } as unknown as MailActionProvider,
      null
    )
    expect(getAttachmentData).toHaveBeenCalledWith('message-new', 'attachment-new')
  })
})
