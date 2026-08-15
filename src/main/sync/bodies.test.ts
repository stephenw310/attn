import { describe, expect, it, vi } from 'vitest'
import type { Db } from '../db'
import type { GmailThread } from '../gmail/parse'
import { hydrateMissingThreadBodies } from './bodies'
import type { MailProvider } from './provider'

function externalThread(): GmailThread {
  return {
    id: 't1',
    messages: [
      {
        id: 'm1',
        threadId: 't1',
        payload: {
          mimeType: 'text/plain',
          body: { attachmentId: 'body-1' }
        }
      }
    ]
  }
}

function provider(): MailProvider {
  return {
    modifyThread: vi.fn(async () => {}),
    trashThread: vi.fn(async () => {}),
    untrashThread: vi.fn(async () => {}),
    getProfile: vi.fn(async () => ({ emailAddress: 'test@example.com', historyId: '1' })),
    listLabels: vi.fn(async () => []),
    listThreadIds: vi.fn(async () => ({ threadIds: [] })),
    getThread: vi.fn(async () => externalThread()),
    getAttachmentData: vi.fn(async () => Buffer.from('fetched body').toString('base64url')),
    listHistory: vi.fn(async () => ({ history: [], historyId: '1' }))
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function bodyDb(
  row: { body_text: string | null; body_html: string | null },
  write: ReturnType<typeof vi.fn>
): Db {
  return {
    prepare: (sql: string) => ({
      get: () => row,
      run: (...args: unknown[]) => {
        if (sql.startsWith('UPDATE messages SET body_text')) write(...args)
        return { changes: 1 }
      }
    })
  } as unknown as Db
}

describe('external body hydration', () => {
  it('skips attachments when a complete body is already cached', async () => {
    const mail = provider()
    await hydrateMissingThreadBodies(
      bodyDb({ body_text: 'already cached', body_html: null }, vi.fn()),
      mail,
      'test@example.com',
      externalThread()
    )
    expect(mail.getAttachmentData).not.toHaveBeenCalled()
  })

  it('fetches and stores a missing out-of-line body', async () => {
    const mail = provider()
    const write = vi.fn()
    await hydrateMissingThreadBodies(
      bodyDb({ body_text: null, body_html: null }, write),
      mail,
      'test@example.com',
      externalThread()
    )
    expect(mail.getAttachmentData).toHaveBeenCalledWith('m1', 'body-1')
    expect(write).toHaveBeenCalledWith('fetched body', null, 'test@example.com', 'm1')
  })

  it('does not write an out-of-line body after its lifecycle guard closes', async () => {
    const fetched = deferred<string>()
    const mail = provider()
    vi.mocked(mail.getAttachmentData).mockReturnValue(fetched.promise)
    const write = vi.fn()
    let active = true
    const attempt = hydrateMissingThreadBodies(
      bodyDb({ body_text: null, body_html: null }, write),
      mail,
      'test@example.com',
      externalThread(),
      () => active
    )

    active = false
    fetched.resolve(Buffer.from('late body').toString('base64url'))
    await attempt

    expect(write).not.toHaveBeenCalled()
  })
})
