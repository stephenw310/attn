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
    const parsed = await parseRemoteDraft(emptyLookupDb(), 'account', remote, provider, 200, {
      priority: 'background'
    })

    expect(provider.getAttachmentData).toHaveBeenCalledWith('message-1', 'body-part', {
      priority: 'background'
    })
    expect(parsed.input.bodyHtml).toBe('<p>Large body</p>')
    expect(parsed.input.bodyText).toBe('Large body')
  })

  it('recovers a reply quote that Gmail merged into the body, without changing the fingerprint', async () => {
    const bodyHtml =
      '<div>my answer</div>\n<div>On Sun, 16 Aug 2026, Sender wrote:</div><blockquote><table width="600"><tr><td>Newsletter</td></tr></table></blockquote>'
    const remote = providerDraft(
      'Re: Newsletter',
      { mimeType: 'text/html', body: { data: Buffer.from(bodyHtml).toString('base64url') } },
      [{ name: 'In-Reply-To', value: '<original@attn.test>' }]
    )
    const parsed = await parseRemoteDraft(emptyLookupDb(), 'account', remote, null, 200)

    expect(parsed.input.kind).toBe('reply')
    expect(parsed.input.bodyHtml).toBe('<div>my answer</div>')
    expect(parsed.input.quoteHtml).toContain('<blockquote>')
    // The local row that mirrored this same content must not read as changed,
    // or every sync would import the draft over the author's own copy.
    expect(parsed.fingerprint).toBe(
      draftContentFingerprint({
        ...emptyDraftInput(),
        subject: 'Re: Newsletter',
        // The two columns a local row holds are stated here; recipients and
        // threading are borrowed, since neither is what this pins.
        bodyHtml: '<div>my answer</div>',
        quoteHtml: parsed.input.quoteHtml,
        to: parsed.input.to,
        inReplyTo: parsed.input.inReplyTo,
        references: parsed.input.references
      })
    )
  })

  it('leaves a new draft that ends in a quote alone', async () => {
    const bodyHtml = '<div>see below</div><blockquote>Pasted material</blockquote>'
    const remote = providerDraft('Notes', {
      mimeType: 'text/html',
      body: { data: Buffer.from(bodyHtml).toString('base64url') }
    })
    const parsed = await parseRemoteDraft(emptyLookupDb(), 'account', remote, null, 200)

    expect(parsed.input.kind).toBe('new')
    expect(parsed.input.bodyHtml).toBe(bodyHtml)
    expect(parsed.input.quoteHtml).toBe('')
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

  it('does not duplicate a mirrored file when Gmail echoes it back', () => {
    const local: StoredDraftAttachment = {
      id: 'local-file',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
      spoolPath: '/owned/outbox/draft/report.pdf'
    }
    // What parseRemoteDraft builds from the draft this file was mirrored into.
    const echo: StoredDraftAttachment = {
      id: 'remote-echo',
      filename: 'report.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
      spoolPath: '',
      remoteMessageId: 'message-1',
      remoteAttachmentId: 'attachment-1'
    }

    const once = mergeRemoteDraftAttachments([echo], JSON.stringify([local]))
    expect(once).toEqual([local])
    // Round-tripping again must stay a fixed point rather than compounding.
    expect(mergeRemoteDraftAttachments([echo], JSON.stringify(once))).toEqual([local])
  })

  it('pairs an echo of a non-ASCII filename, in the current and the legacy fold', () => {
    // The upload now carries `résumé.pdf` in an RFC 2231 continuation, so that
    // is what Gmail echoes. A draft checkpointed before that shipped still
    // echoes the ASCII fold, and both must pair with the local file: matching
    // neither would append a copy per round trip, and each checkpoint would
    // then upload every copy.
    const local: StoredDraftAttachment = {
      id: 'local-file',
      filename: 'résumé.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 10,
      spoolPath: '/owned/outbox/draft/résumé.pdf'
    }
    const echo = (filename: string): StoredDraftAttachment => ({
      id: 'remote-echo',
      filename,
      mimeType: 'application/pdf',
      sizeBytes: 10,
      spoolPath: '',
      remoteMessageId: 'message-1',
      remoteAttachmentId: 'attachment-1'
    })

    for (const echoed of ['résumé.pdf', 'r_sum_.pdf']) {
      const once = mergeRemoteDraftAttachments([echo(echoed)], JSON.stringify([local]))
      expect(once).toEqual([local])
      // Round-tripping again must stay a fixed point rather than compounding.
      expect(mergeRemoteDraftAttachments([echo(echoed)], JSON.stringify(once))).toEqual([local])
    }
  })

  it('fingerprints a filename the way Gmail will echo it', () => {
    const base = { ...emptyDraftInput(), to: [{ name: '', email: 'to@example.com' }] }
    const attachment = { id: 'a', mimeType: 'application/pdf', sizeBytes: 10 }
    const fingerprintOf = (filename: string): string =>
      draftContentFingerprint({ ...base, attachments: [{ ...attachment, filename }] })

    // The RFC 2231 continuation carries the real name, so that is the identity
    // — and an ASCII fold of it is a different file, not the same one.
    expect(fingerprintOf('résumé.pdf')).not.toBe(fingerprintOf('r_sum_.pdf'))
    expect(fingerprintOf('résumé.pdf')).toBe(fingerprintOf(' résumé.pdf '))
  })

  it('pairs an echo with its own file when two attachments share a name', () => {
    const first: StoredDraftAttachment = {
      id: 'first',
      filename: 'photo.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: 10,
      spoolPath: '/owned/outbox/draft/1/photo.jpg'
    }
    const second: StoredDraftAttachment = { ...first, id: 'second', sizeBytes: 20 }
    const echoes: StoredDraftAttachment[] = [
      { ...second, id: 'echo-second', spoolPath: '', remoteAttachmentId: 'b' },
      { ...first, id: 'echo-first', spoolPath: '', remoteAttachmentId: 'a' }
    ]

    expect(mergeRemoteDraftAttachments(echoes, JSON.stringify([first, second]))).toEqual([second, first])
  })

  it('keeps an inline image spool-backed instead of adopting the remote copy', () => {
    const local: StoredDraftAttachment = {
      id: 'inline-local',
      filename: 'pasted.png',
      mimeType: 'image/png',
      sizeBytes: 7,
      spoolPath: '/owned/outbox/draft/pasted.png',
      contentId: 'pasted@attn.local',
      inline: true
    }
    const echo: StoredDraftAttachment = {
      ...local,
      id: 'inline-remote',
      spoolPath: '',
      remoteMessageId: 'message-1',
      remoteAttachmentId: 'attachment-1'
    }

    expect(mergeRemoteDraftAttachments([echo], JSON.stringify([local]))).toEqual([local])
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

    await expect(syncRemoteDrafts(db, 'account', provider as never)).resolves.toMatchObject({
      changed: false
    })
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
        if (sql.includes('SELECT gmail_draft_id, gmail_message_id, state, kind, thread_id')) {
          return {
            all: vi.fn(() => [
              {
                gmail_draft_id: 'draft-1',
                gmail_message_id: 'message-1',
                state: 'drafted',
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
        // The send state machine never owns this legacy row, so the claim finds
        // no owner and reconciliation proceeds to the thread-binding repair.
        if (sql.includes("state NOT IN ('composing', 'drafted')")) {
          return { get: vi.fn(() => undefined) }
        }
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

    await expect(syncRemoteDrafts(db, 'account', provider as never)).resolves.toMatchObject({
      changed: true
    })
    await expect(syncRemoteDrafts(db, 'account', provider as never)).resolves.toMatchObject({
      changed: false
    })
    expect(getDraft).toHaveBeenCalledWith('draft-1', { priority: 'polling' })
    expect(getDraft).toHaveBeenCalledTimes(1)
    expect(repairBinding).toHaveBeenCalledWith('forward', 'thread-1', 'account', 'local-draft')
    expect(writeRemote.mock.calls[0]?.[4]).toBe('forward')
    expect(writeRemote.mock.calls[0]?.[12]).toBe('thread-1')
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

    await expect(syncRemoteDrafts(db, 'account', provider as never)).resolves.toMatchObject({
      changed: false
    })
    expect(getDraft).not.toHaveBeenCalled()
  })

  it('removes or unbinds a known draft that a complete listing no longer returns', async () => {
    const run = vi.fn(() => ({ changes: 1 }))
    const provider = { listDrafts: vi.fn(async () => ({ drafts: [] })), getDraft: vi.fn() }
    const db = {
      prepare: vi.fn((sql: string) => ({
        run,
        all: vi.fn(() =>
          sql.includes('gmail_message_id')
            ? [
                { gmail_draft_id: 'draft-closed', gmail_message_id: 'm1', state: 'drafted' },
                { gmail_draft_id: 'draft-open', gmail_message_id: 'm2', state: 'composing' }
              ]
            : [
                {
                  id: 'closed',
                  state: 'drafted',
                  gmail_draft_id: 'draft-closed',
                  local_revision: 1,
                  mirror_revision: 1
                },
                {
                  id: 'open',
                  state: 'composing',
                  gmail_draft_id: 'draft-open',
                  local_revision: 3,
                  mirror_revision: 3
                }
              ]
        )
      }))
    } as unknown as Db

    // The deleted ids come back so the caller drops their attachment spool now
    // rather than leaving it for the next launch's reconciliation.
    await expect(syncRemoteDrafts(db, 'account', provider as never)).resolves.toEqual({
      changed: true,
      deletedIds: ['closed']
    })
    // Deleted in Gmail while closed and fully mirrored → the local row goes too.
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('DELETE FROM outbox'))
    expect(run).toHaveBeenCalledWith('account', 'closed')
    // An open composer never loses text: it drops the dead binding instead.
    expect(db.prepare).toHaveBeenCalledWith(expect.stringContaining('gmail_draft_id = NULL'))
    expect(run).toHaveBeenCalledWith('account', 'open')
  })

  it('does not judge a draft that acquired its Gmail id while the listing was in flight', async () => {
    // The mirror's first checkpoint (drafts.create) can return between the
    // known-draft snapshot and the end of a paginated drafts.list. Such a row is
    // bound but absent from a listing that predates its creation; treating that
    // absence as a remote deletion would delete a drafted row or, for an open
    // composer, clear the binding and make the mirror create a duplicate.
    const run = vi.fn(() => ({ changes: 1 }))
    const provider = { listDrafts: vi.fn(async () => ({ drafts: [] })), getDraft: vi.fn() }
    const db = {
      prepare: vi.fn((sql: string) => ({
        run,
        all: vi.fn(() =>
          sql.includes('gmail_message_id')
            ? [] // nothing was bound when the listing began
            : [
                {
                  id: 'closed',
                  state: 'drafted',
                  gmail_draft_id: 'draft-created-during-listing',
                  local_revision: 1,
                  mirror_revision: 1
                },
                {
                  id: 'open',
                  state: 'composing',
                  gmail_draft_id: 'draft-created-during-listing-2',
                  local_revision: 3,
                  mirror_revision: 3
                }
              ]
        )
      }))
    } as unknown as Db

    await expect(syncRemoteDrafts(db, 'account', provider as never)).resolves.toMatchObject({
      changed: false
    })
    expect(run).not.toHaveBeenCalled()
    expect(db.prepare).not.toHaveBeenCalledWith(expect.stringContaining('DELETE FROM outbox'))
    expect(db.prepare).not.toHaveBeenCalledWith(expect.stringContaining('gmail_draft_id = NULL'))
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
    expect(getAttachmentData).toHaveBeenCalledWith('message-new', 'attachment-new', undefined)
  })
})
