import { describe, expect, it, vi } from 'vitest'
import { emptyDraftInput } from '../../shared/drafts'
import type { Db } from '../db'
import type { GmailPart } from '../gmail/parse'
import type { MailActionProvider, ProviderDraft } from '../sync/provider'
import { parseStoredDraftAttachments, type StoredDraftAttachment } from './draftAttachments'
import {
  draftContentFingerprint,
  mergeRemoteDraftAttachments,
  parseRemoteDraft,
  planDraftConflict,
  reconcileRemoteDraft,
  refreshRemoteAttachmentLocators,
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

function providerDraft(subject: string, body: GmailPart): ProviderDraft {
  return {
    id: 'draft-1',
    message: {
      id: 'message-1',
      threadId: 'thread-1',
      internalDate: '100',
      payload: {
        mimeType: 'multipart/alternative',
        headers: [
          { name: 'Subject', value: subject },
          { name: 'To', value: 'to@example.com' }
        ],
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
})

describe('draft synchronization identity', () => {
  it('refreshes locators by MIME identity when inline parts precede regular parts remotely', async () => {
    const regular: StoredDraftAttachment = {
      id: 'regular',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 7,
      spoolPath: '',
      remoteMessageId: 'old-message',
      remoteAttachmentId: 'old-regular'
    }
    const inline: StoredDraftAttachment = {
      id: 'inline',
      filename: 'pasted.png',
      mimeType: 'image/png',
      sizeBytes: 6,
      spoolPath: '/owned/outbox/draft/pasted.png',
      contentId: 'pasted-image',
      inline: true,
      remoteMessageId: 'old-message',
      remoteAttachmentId: 'old-inline'
    }
    const remoteInline = {
      ...inline,
      id: 'remote-inline',
      spoolPath: '',
      remoteMessageId: 'new-message',
      remoteAttachmentId: 'new-inline'
    }
    const remoteRegular = {
      ...regular,
      id: 'remote-regular',
      remoteMessageId: 'new-message',
      remoteAttachmentId: 'new-regular'
    }

    const refreshed = parseStoredDraftAttachments(
      refreshRemoteAttachmentLocators(JSON.stringify([regular, inline]), [remoteInline, remoteRegular])
    )
    expect(refreshed).toEqual([
      expect.objectContaining({
        id: 'regular',
        remoteMessageId: 'new-message',
        remoteAttachmentId: 'new-regular'
      }),
      expect.objectContaining({
        id: 'inline',
        remoteMessageId: 'new-message',
        remoteAttachmentId: 'new-inline'
      })
    ])

    const getAttachmentData = vi.fn(async (_messageId: string, attachmentId: string) =>
      Buffer.from(attachmentId === 'new-regular' ? 'regular' : 'inline').toString('base64url')
    )
    const loaded = await loadDraftMimeAttachments(
      'draft',
      refreshed.map((attachment) => ({ ...attachment, spoolPath: '' })),
      { getAttachmentData } as unknown as MailActionProvider,
      null
    )
    expect(
      loaded.map((attachment) => [attachment.filename, Buffer.from(attachment.content).toString()])
    ).toEqual([
      ['report.pdf', 'regular'],
      ['pasted.png', 'inline']
    ])
  })

  it('preserves local-only file attachments when a newer remote body wins', () => {
    const local: StoredDraftAttachment = {
      id: 'local-file',
      filename: 'local.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 4,
      spoolPath: '/owned/outbox/draft/local.pdf'
    }
    const remote: StoredDraftAttachment = {
      id: 'remote-file',
      filename: 'remote.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 5,
      spoolPath: '',
      remoteMessageId: 'message-1',
      remoteAttachmentId: 'attachment-1'
    }

    expect(mergeRemoteDraftAttachments([remote], JSON.stringify([local]))).toEqual([remote, local])
  })

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
            ? [{ gmail_draft_id: 'draft-1', gmail_message_id: 'message-1', state: 'drafted' }]
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

  it('does not re-import a Gmail draft already owned by a queued send', async () => {
    const getDraft = vi.fn()
    const provider = {
      listDrafts: vi.fn(async () => ({ drafts: [{ id: 'draft-1', messageId: 'new-message-id' }] })),
      getDraft
    }
    const db = {
      prepare: vi.fn((sql: string) => ({
        all: vi.fn(() =>
          sql.includes('gmail_message_id')
            ? [{ gmail_draft_id: 'draft-1', gmail_message_id: 'old-message-id', state: 'queued' }]
            : []
        )
      }))
    } as unknown as Db

    await expect(syncRemoteDrafts(db, 'account', provider as never)).resolves.toBe(false)
    expect(getDraft).not.toHaveBeenCalled()
  })

  it('binds an orphaned remote draft to its sending row by stable Message-ID', async () => {
    const run = vi.fn(() => ({ changes: 1 }))
    const claimQuery = vi.fn(() => ({ id: 'outbox-1' }))
    const db = {
      prepare: vi.fn((sql: string) => ({
        run,
        get: sql.includes("state NOT IN ('composing', 'drafted')") ? claimQuery : vi.fn(() => undefined)
      }))
    } as unknown as Db
    const remote = providerDraft('Orphan', { mimeType: 'text/plain' })
    if (!remote.message.payload) throw new Error('missing test payload')
    remote.message.payload.headers?.push({ name: 'Message-ID', value: '<stable@attn.local>' })

    await expect(reconcileRemoteDraft(db, 'account', remote)).resolves.toBe('local')
    // The Message-ID clause is scoped to rows still mid-send: a `sent` row keeps
    // its Message-ID for a week and must never absorb an unrelated orphan draft.
    expect(claimQuery).toHaveBeenCalledWith(
      'account',
      'draft-1',
      '<stable@attn.local>',
      '<stable@attn.local>'
    )
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining("state IN ('queued', 'sending')"))
    expect(run).toHaveBeenCalledWith('draft-1', 'message-1', 'account', 'outbox-1')
  })

  it('leaves an orphaned Gmail draft alone when only a sent row shares its Message-ID', async () => {
    const run = vi.fn(() => ({ changes: 1 }))
    // No mid-send row matches, so the claim finds nothing and normal import runs.
    const db = {
      prepare: vi.fn((sql: string) => ({
        run,
        get: vi.fn(() => undefined),
        all: vi.fn(() => (sql.includes('gmail_message_id') ? [] : []))
      }))
    } as unknown as Db
    const remote = providerDraft('Orphan', { mimeType: 'text/plain' })
    if (!remote.message.payload) throw new Error('missing test payload')
    remote.message.payload.headers?.push({ name: 'Message-ID', value: '<stable@attn.local>' })

    await expect(reconcileRemoteDraft(db, 'account', remote)).resolves.toBe('remote')
    expect(run).not.toHaveBeenCalledWith('draft-1', 'message-1', 'account', expect.anything())
  })

  it('refreshes remote locators beside a local-only attachment when Gmail replaces the message', async () => {
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
    const localOnly: StoredDraftAttachment = {
      id: 'local-file',
      filename: 'local.txt',
      mimeType: 'text/plain',
      sizeBytes: 5,
      spoolPath: '/owned/outbox/local-draft/local.txt'
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
              attachments_json: JSON.stringify([previous, localOnly])
            }))
          }
        }
        if (sql.includes("state NOT IN ('composing', 'drafted')")) {
          return { get: vi.fn(() => undefined) }
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
      }),
      localOnly
    ])
    const getAttachmentData = vi.fn(async (_messageId: string, _attachmentId: string) =>
      Buffer.from('data').toString('base64url')
    )
    await loadDraftMimeAttachments(
      'local-draft',
      [refreshed[0]],
      { getAttachmentData } as unknown as MailActionProvider,
      null
    )
    expect(getAttachmentData).toHaveBeenCalledWith('message-new', 'attachment-new')
  })
})
