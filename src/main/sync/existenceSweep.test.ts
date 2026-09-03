import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../db'
import { GmailApiError } from '../gmail/client'
import type { GmailThread } from '../gmail/parse'
import { fakeMailProvider } from '../testing/fakes'
import { reconcileThreadExistence } from './existenceSweep'
import { persistThread } from './persist'
import type { ListThreadIdsOptions, MailProvider, ThreadIdPage } from './provider'

function thread(id: string, labelIds: string[] = []): GmailThread {
  return {
    id,
    messages: [
      {
        id: `message-${id}`,
        threadId: id,
        labelIds,
        internalDate: '100',
        snippet: id,
        payload: {
          headers: [
            { name: 'From', value: `${id} <${id}@example.com>` },
            { name: 'Subject', value: id }
          ]
        }
      }
    ]
  }
}

function provider(
  listThreadIds: (options: ListThreadIdsOptions) => Promise<ThreadIdPage>,
  getThread: (id: string) => Promise<GmailThread> = async (id) => thread(id)
): MailProvider {
  return fakeMailProvider({ listThreadIds: vi.fn(listThreadIds), getThread: vi.fn(getThread) })
}

describe('thread existence sweep', () => {
  it('deletes only threads absent from an exhausted all-mail, Spam, and Trash union', async () => {
    const db = openDatabase(':memory:')
    try {
      for (const snapshot of [
        thread('archived'),
        thread('normal', ['INBOX']),
        thread('junk', ['SPAM']),
        thread('bin', ['TRASH']),
        thread('deleted')
      ]) {
        persistThread(db, 'account', snapshot)
      }
      db.prepare(
        `INSERT INTO action_queue (account_id, kind, thread_id, payload, state)
         VALUES ('account', 'modifyLabels', 'deleted', '{"add":["STARRED"],"remove":[]}', 'pending')`
      ).run()
      db.prepare(
        `INSERT INTO reminders (account_id, thread_id, kind, due_at, state)
         VALUES ('account', 'deleted', 'snooze', 100, 'pending')`
      ).run()

      const mail = provider(
        async (options) => {
          if (options.labelIds?.includes('SPAM')) return { threadIds: ['junk'] }
          if (options.labelIds?.includes('TRASH')) return { threadIds: ['bin'] }
          if (!options.pageToken) return { threadIds: ['archived'], nextPageToken: 'page-2' }
          return { threadIds: ['normal'] }
        },
        async (id) => {
          if (id === 'deleted') throw new GmailApiError(404, 'gone')
          return thread(id)
        }
      )

      await expect(reconcileThreadExistence(db, 'account', mail)).resolves.toEqual({
        listedThreadCount: 4,
        deletedThreadIds: ['deleted']
      })
      expect(db.prepare('SELECT id FROM threads ORDER BY id').all()).toEqual([
        { id: 'archived' },
        { id: 'bin' },
        { id: 'junk' },
        { id: 'normal' }
      ])
      // A tombstone removes the stale snapshot, not the user's durable intent.
      expect(db.prepare('SELECT thread_id, state FROM action_queue').all()).toEqual([
        { thread_id: 'deleted', state: 'pending' }
      ])
      expect(db.prepare('SELECT thread_id FROM reminders').all()).toEqual([])
      expect(mail.listThreadIds).toHaveBeenCalledWith({
        labelIds: ['SPAM'],
        includeSpamTrash: true,
        pageToken: undefined,
        priority: 'background'
      })
      expect(mail.listThreadIds).toHaveBeenCalledWith({
        labelIds: ['TRASH'],
        includeSpamTrash: true,
        pageToken: undefined,
        priority: 'background'
      })
    } finally {
      db.close()
    }
  })

  it('deletes nothing when any listing is interrupted before exhaustion', async () => {
    const root = mkdtempSync(join(tmpdir(), 'attn-existence-'))
    let db = openDatabase(join(root, 'attn.db'))
    try {
      persistThread(db, 'account', thread('archived'))
      persistThread(db, 'account', thread('would-look-missing'))
      const mail = provider(async (options) => {
        if (!options.pageToken) return { threadIds: ['archived'], nextPageToken: 'page-2' }
        throw new Error('offline')
      })

      await expect(reconcileThreadExistence(db, 'account', mail)).rejects.toThrow('offline')
      expect(db.prepare('SELECT id FROM threads ORDER BY id').all()).toEqual([
        { id: 'archived' },
        { id: 'would-look-missing' }
      ])

      db.close()
      db = openDatabase(join(root, 'attn.db'))
      const resumed = provider(async (options) => {
        if (options.labelIds?.length) return { threadIds: [] }
        if (options.pageToken !== 'page-2') throw new Error('sweep restarted instead of resuming')
        return { threadIds: ['would-look-missing'] }
      })
      await expect(reconcileThreadExistence(db, 'account', resumed)).resolves.toEqual({
        listedThreadCount: 2,
        deletedThreadIds: []
      })
      expect(resumed.listThreadIds).toHaveBeenNthCalledWith(1, {
        pageToken: 'page-2',
        priority: 'background'
      })
    } finally {
      if (db.open) db.close()
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('deletes nothing when the account session changes after a page request', async () => {
    const db = openDatabase(':memory:')
    try {
      persistThread(db, 'account', thread('local'))
      let active = true
      const mail = provider(async () => {
        active = false
        return { threadIds: [] }
      })

      await expect(
        reconcileThreadExistence(db, 'account', mail, { shouldContinue: () => active })
      ).resolves.toBeNull()
      expect(db.prepare('SELECT id FROM threads').all()).toEqual([{ id: 'local' }])
    } finally {
      db.close()
    }
  })

  it('restarts the complete listing once when a durable page token expires', async () => {
    const db = openDatabase(':memory:')
    try {
      persistThread(db, 'account', thread('a'))
      persistThread(db, 'account', thread('b'))
      const listThreadIds = vi
        .fn<(options: ListThreadIdsOptions) => Promise<ThreadIdPage>>()
        .mockResolvedValueOnce({ threadIds: ['a'], nextPageToken: 'expired' })
        .mockRejectedValueOnce(new GmailApiError(400, 'invalid page token'))
        .mockImplementation(async (options) =>
          options.labelIds?.length ? { threadIds: [] } : { threadIds: ['a', 'b'] }
        )
      const mail = provider(listThreadIds)

      await expect(reconcileThreadExistence(db, 'account', mail)).resolves.toEqual({
        listedThreadCount: 2,
        deletedThreadIds: []
      })
      expect(listThreadIds).toHaveBeenNthCalledWith(2, {
        pageToken: 'expired',
        priority: 'background'
      })
      expect(listThreadIds).toHaveBeenNthCalledWith(3, {
        pageToken: undefined,
        priority: 'background'
      })
    } finally {
      db.close()
    }
  })

  it.each([400, 404])('does not reset a saved cursor for an unrelated %i response', async (status) => {
    const db = openDatabase(':memory:')
    try {
      persistThread(db, 'account', thread('a'))
      const listThreadIds = vi
        .fn<(options: ListThreadIdsOptions) => Promise<ThreadIdPage>>()
        .mockResolvedValueOnce({ threadIds: ['a'], nextPageToken: 'page-2' })
        .mockRejectedValueOnce(new GmailApiError(status, 'invalid labelIds argument'))
      const mail = provider(listThreadIds)

      await expect(reconcileThreadExistence(db, 'account', mail)).rejects.toMatchObject({ status })
      expect(listThreadIds).toHaveBeenCalledTimes(2)
      expect(
        db.prepare('SELECT phase, page_token FROM thread_existence_state WHERE account_id = ?').get('account')
      ).toEqual({ phase: 'all-mail', page_token: 'page-2' })
    } finally {
      db.close()
    }
  })

  it('never considers a thread persisted after the initial local snapshot', async () => {
    const db = openDatabase(':memory:')
    try {
      persistThread(db, 'account', thread('before'))
      const mail = provider(async (options) => {
        if (options.labelIds?.length) return { threadIds: [] }
        persistThread(db, 'account', thread('during'))
        return { threadIds: ['before'] }
      })

      await expect(reconcileThreadExistence(db, 'account', mail)).resolves.toEqual({
        listedThreadCount: 1,
        deletedThreadIds: []
      })
      expect(db.prepare('SELECT id FROM threads ORDER BY id').all()).toEqual([
        { id: 'before' },
        { id: 'during' }
      ])
    } finally {
      db.close()
    }
  })

  it('retains live candidates when direct fetches contradict an empty listing', async () => {
    const db = openDatabase(':memory:')
    try {
      persistThread(db, 'account', thread('a'))
      persistThread(db, 'account', thread('b'))
      const mail = provider(async () => ({ threadIds: [] }))

      await expect(reconcileThreadExistence(db, 'account', mail)).resolves.toEqual({
        listedThreadCount: 0,
        deletedThreadIds: []
      })
      expect(db.prepare('SELECT id FROM threads ORDER BY id').all()).toEqual([{ id: 'a' }, { id: 'b' }])
      expect(mail.getThread).toHaveBeenNthCalledWith(1, 'a', {
        format: 'metadata',
        priority: 'background'
      })
      expect(mail.getThread).toHaveBeenNthCalledWith(2, 'b', {
        format: 'metadata',
        priority: 'background'
      })
    } finally {
      db.close()
    }
  })

  it('retains a live thread missed while it moves between listing scopes', async () => {
    const db = openDatabase(':memory:')
    try {
      const threadIds = Array.from({ length: 20 }, (_, index) => `t${index}`)
      for (const id of threadIds) persistThread(db, 'account', thread(id))
      let movedOutOfTrash = false
      const mail = provider(async (options) => {
        if (!options.labelIds?.length) {
          movedOutOfTrash = true
          return { threadIds: threadIds.filter((id) => id !== 't7') }
        }
        if (!movedOutOfTrash) throw new Error('scope transition did not occur')
        return { threadIds: [] }
      })

      await expect(reconcileThreadExistence(db, 'account', mail)).resolves.toEqual({
        listedThreadCount: 19,
        deletedThreadIds: []
      })
      expect(mail.getThread).toHaveBeenCalledOnce()
      expect(mail.getThread).toHaveBeenCalledWith('t7', {
        format: 'metadata',
        priority: 'background'
      })
      expect(
        db.prepare('SELECT id FROM threads WHERE account_id = ? AND id = ?').get('account', 't7')
      ).toEqual({ id: 't7' })
    } finally {
      db.close()
    }
  })

  it('resumes candidate verification and deletes only direct-fetch 404s', async () => {
    const db = openDatabase(':memory:')
    try {
      persistThread(db, 'account', thread('a'))
      persistThread(db, 'account', thread('b'))
      const interrupted = provider(
        async () => ({ threadIds: [] }),
        vi
          .fn<(id: string) => Promise<GmailThread>>()
          .mockRejectedValueOnce(new GmailApiError(404, 'gone'))
          .mockRejectedValueOnce(new Error('offline'))
      )

      await expect(reconcileThreadExistence(db, 'account', interrupted)).rejects.toThrow('offline')
      expect(db.prepare('SELECT id FROM threads ORDER BY id').all()).toEqual([{ id: 'a' }, { id: 'b' }])

      const resumed = provider(
        async () => {
          throw new Error('completed listings should not restart during verification')
        },
        async () => {
          throw new GmailApiError(404, 'gone')
        }
      )
      await expect(reconcileThreadExistence(db, 'account', resumed)).resolves.toEqual({
        listedThreadCount: 0,
        deletedThreadIds: ['a', 'b']
      })
      expect(resumed.listThreadIds).not.toHaveBeenCalled()
      expect(resumed.getThread).toHaveBeenCalledOnce()
      expect(resumed.getThread).toHaveBeenCalledWith('b', {
        format: 'metadata',
        priority: 'background'
      })
    } finally {
      db.close()
    }
  })

  it('does not retain a 404 from a canceled account session as deletion evidence', async () => {
    const db = openDatabase(':memory:')
    try {
      persistThread(db, 'account', thread('a'))
      let active = true
      const mail = provider(
        async () => ({ threadIds: [] }),
        async () => {
          active = false
          throw new GmailApiError(404, 'gone')
        }
      )

      await expect(
        reconcileThreadExistence(db, 'account', mail, { shouldContinue: () => active })
      ).resolves.toBeNull()
      expect(db.prepare('SELECT id FROM threads').all()).toEqual([{ id: 'a' }])
      expect(
        db
          .prepare(
            `SELECT verified_missing
             FROM thread_existence_evidence
             WHERE account_id = ? AND thread_id = ?`
          )
          .get('account', 'a')
      ).toEqual({ verified_missing: 0 })
    } finally {
      db.close()
    }
  })
})
