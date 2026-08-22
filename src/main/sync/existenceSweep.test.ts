import { describe, expect, it, vi } from 'vitest'
import { openDatabase } from '../db'
import type { GmailThread } from '../gmail/parse'
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

function provider(listThreadIds: (options: ListThreadIdsOptions) => Promise<ThreadIdPage>): MailProvider {
  return {
    modifyThread: vi.fn(async () => {}),
    trashThread: vi.fn(async () => {}),
    untrashThread: vi.fn(async () => {}),
    getProfile: vi.fn(async () => ({ emailAddress: 'account', historyId: '1' })),
    listLabels: vi.fn(async () => []),
    listThreadIds: vi.fn(listThreadIds),
    getThread: vi.fn(async (id) => thread(id)),
    getAttachmentData: vi.fn(async () => undefined),
    listHistory: vi.fn(async () => ({ history: [], historyId: '1' })),
    listDrafts: vi.fn(async () => ({ drafts: [] })),
    getDraft: vi.fn(async (id) => ({ id, message: { id: `message-${id}`, threadId: id } }))
  }
}

describe('thread existence sweep', () => {
  it('deletes only threads absent from an exhausted all-mail, Spam, and Trash union', async () => {
    const db = openDatabase(':memory:')
    try {
      for (const snapshot of [
        thread('archived'),
        thread('normal', ['INBOX']),
        thread('junk', ['SPAM']),
        thread('deleted')
      ]) {
        persistThread(db, 'account', snapshot)
      }
      db.prepare(
        `INSERT INTO action_queue (account_id, kind, thread_id, payload, state)
         VALUES ('account', 'modifyLabels', 'deleted', '{"add":["STARRED"],"remove":[]}', 'pending')`
      ).run()

      const mail = provider(async (options) => {
        if (options.labelIds?.includes('SPAM')) return { threadIds: ['junk'] }
        if (options.labelIds?.includes('TRASH')) return { threadIds: [] }
        if (!options.pageToken) return { threadIds: ['archived'], nextPageToken: 'page-2' }
        return { threadIds: ['normal'] }
      })

      await expect(reconcileThreadExistence(db, 'account', mail)).resolves.toEqual({
        listedThreadCount: 3,
        deletedThreadIds: ['deleted']
      })
      expect(db.prepare('SELECT id FROM threads ORDER BY id').all()).toEqual([
        { id: 'archived' },
        { id: 'junk' },
        { id: 'normal' }
      ])
      // A tombstone removes the stale snapshot, not the user's durable intent.
      expect(db.prepare('SELECT thread_id, state FROM action_queue').all()).toEqual([
        { thread_id: 'deleted', state: 'pending' }
      ])
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
    const db = openDatabase(':memory:')
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
    } finally {
      db.close()
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
})
