import { afterEach, describe, expect, it, vi } from 'vitest'
import { type Db, openDatabase } from '../db'
import type { GmailThread } from '../gmail/parse'
import { fakeMailProvider } from '../testing/fakes'
import { planSplitMetadataStart, runSplitMetadataRebuild, type SplitMetadataCallbacks } from './splitMetadata'

const ACCOUNT = 'upgrade@example.com'
const NO_PAUSE = { requestIntervalMs: 0, pagePauseMs: 0, foregroundYieldMs: 0 }

function callbacks(): SplitMetadataCallbacks & {
  onProgress: ReturnType<typeof vi.fn>
  onError: ReturnType<typeof vi.fn>
} {
  return { onProgress: vi.fn(), onError: vi.fn() }
}

function upgradedStore(cursor = 'split-metadata'): Db {
  const db = openDatabase(':memory:')
  db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, 1)').run(ACCOUNT, ACCOUNT)
  db.prepare(
    `INSERT INTO sync_state (account_id, backfill_cursor, split_metadata_cursor)
     VALUES (?, 'done', ?)`
  ).run(ACCOUNT, cursor)
  db.prepare(
    `INSERT INTO threads
     (account_id, id, subject, last_msg_at, is_inbox_visible)
     VALUES (?, 'stored', 'Stored invite', 1, 1)`
  ).run(ACCOUNT)
  db.prepare(
    `INSERT INTO thread_labels (account_id, thread_id, label_id)
     VALUES (?, 'stored', 'INBOX')`
  ).run(ACCOUNT)
  // This is the important upgrade shape: bodies already exist and the normal
  // backfill is done, but the newly added split fields have their defaults.
  db.prepare(
    `INSERT INTO messages
     (account_id, id, thread_id, from_email, internal_date, body_text, list_id, has_calendar_part)
     VALUES (?, 'message-stored', 'stored', 'events@example.com', 1, 'already cached', NULL, 0)`
  ).run(ACCOUNT)
  return db
}

function refreshedThread(): GmailThread {
  return {
    id: 'stored',
    messages: [
      {
        id: 'message-stored',
        threadId: 'stored',
        internalDate: '1',
        labelIds: ['INBOX'],
        snippet: 'invite',
        payload: {
          mimeType: 'multipart/alternative',
          headers: [
            { name: 'From', value: 'Events <events@example.com>' },
            { name: 'Subject', value: 'Stored invite' },
            { name: 'List-Id', value: 'Events <EVENTS.EXAMPLE.COM>' }
          ],
          parts: [{ mimeType: 'text/calendar', body: { attachmentId: 'calendar-part', size: 64 } }]
        }
      }
    ]
  }
}

afterEach(() => vi.useRealTimers())

describe('split metadata cursor routing', () => {
  it('routes fresh, resumed, and completed cursors', () => {
    expect(planSplitMetadataStart(null)).toEqual({ kind: 'run' })
    expect(planSplitMetadataStart('split-metadata')).toEqual({ kind: 'run' })
    expect(planSplitMetadataStart('split-metadata:page-2')).toEqual({ kind: 'run', pageToken: 'page-2' })
    expect(planSplitMetadataStart('done')).toEqual({ kind: 'skip' })
    expect(() => planSplitMetadataStart('attachments')).toThrow(/Invalid split metadata cursor/)
  })

  it('defaults new profiles to done because the bodies stage already writes split metadata', () => {
    const db = openDatabase(':memory:')
    db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, 1)').run(ACCOUNT, ACCOUNT)
    db.prepare('INSERT INTO sync_state (account_id) VALUES (?)').run(ACCOUNT)
    expect(
      db.prepare('SELECT split_metadata_cursor FROM sync_state WHERE account_id = ?').get(ACCOUNT)
    ).toEqual({ split_metadata_cursor: 'done' })
    db.close()
  })
})

describe('split metadata rebuild', () => {
  it('re-fetches an upgraded profile even when its normal backfill is already done', async () => {
    const db = upgradedStore()
    const listThreadIds = vi.fn(async () => ({ threadIds: ['stored'] }))
    const getThread = vi.fn(async () => refreshedThread())
    const events = callbacks()

    const result = await runSplitMetadataRebuild(
      db,
      fakeMailProvider({ listThreadIds, getThread }),
      ACCOUNT,
      events,
      NO_PAUSE
    )
    expect(events.onError.mock.calls).toEqual([])
    expect(result).toEqual({ threadsRefreshed: 1 })

    expect(listThreadIds).toHaveBeenCalledWith({
      labelIds: ['INBOX'],
      pageToken: undefined,
      priority: 'background'
    })
    expect(getThread).toHaveBeenCalledWith('stored', { format: 'full', priority: 'background' })
    expect(
      db
        .prepare(
          `SELECT list_id, has_calendar_part FROM messages
         WHERE account_id = ? AND id = 'message-stored'`
        )
        .get(ACCOUNT)
    ).toEqual({ list_id: '<events.example.com>', has_calendar_part: 1 })
    expect(
      db.prepare('SELECT split_metadata_cursor FROM sync_state WHERE account_id = ?').get(ACCOUNT)
    ).toEqual({ split_metadata_cursor: 'done' })
    expect(events.onProgress).toHaveBeenCalledWith({
      threadsDone: 1,
      reason: 'running',
      mailChanged: true
    })
    expect(events.onError).not.toHaveBeenCalled()
    db.close()
  })

  it('costs nothing on a fresh profile whose bodies stage already populated the fields', async () => {
    const db = upgradedStore('done')
    const listThreadIds = vi.fn()
    const getThread = vi.fn()

    await expect(
      runSplitMetadataRebuild(
        db,
        fakeMailProvider({ listThreadIds, getThread }),
        ACCOUNT,
        callbacks(),
        NO_PAUSE
      )
    ).resolves.toEqual({ threadsRefreshed: 0 })

    expect(listThreadIds).not.toHaveBeenCalled()
    expect(getThread).not.toHaveBeenCalled()
    db.close()
  })

  it('re-fetches instead of overwriting mail changed during an in-flight request', async () => {
    const db = upgradedStore()
    let revision = 0
    const getThread = vi
      .fn()
      .mockImplementationOnce(async () => {
        revision += 1
        return refreshedThread()
      })
      .mockImplementationOnce(async () => refreshedThread())

    await expect(
      runSplitMetadataRebuild(
        db,
        fakeMailProvider({ listThreadIds: vi.fn(async () => ({ threadIds: ['stored'] })), getThread }),
        ACCOUNT,
        callbacks(),
        { ...NO_PAUSE, snapshotRevision: () => revision }
      )
    ).resolves.toEqual({ threadsRefreshed: 1 })

    expect(getThread).toHaveBeenCalledTimes(2)
    expect(
      db
        .prepare('SELECT has_calendar_part FROM messages WHERE account_id = ? AND id = ?')
        .get(ACCOUNT, 'message-stored')
    ).toEqual({ has_calendar_part: 1 })
    db.close()
  })

  it('does not write or checkpoint after cancellation during a fetch', async () => {
    const db = upgradedStore()
    let active = true
    const getThread = vi.fn(async () => {
      active = false
      return refreshedThread()
    })

    await expect(
      runSplitMetadataRebuild(
        db,
        fakeMailProvider({ listThreadIds: vi.fn(async () => ({ threadIds: ['stored'] })), getThread }),
        ACCOUNT,
        callbacks(),
        { ...NO_PAUSE, shouldContinue: () => active }
      )
    ).resolves.toBeNull()

    expect(
      db
        .prepare(
          `SELECT list_id, has_calendar_part FROM messages
         WHERE account_id = ? AND id = 'message-stored'`
        )
        .get(ACCOUNT)
    ).toEqual({ list_id: null, has_calendar_part: 0 })
    expect(
      db.prepare('SELECT split_metadata_cursor FROM sync_state WHERE account_id = ?').get(ACCOUNT)
    ).toEqual({ split_metadata_cursor: 'split-metadata' })
    db.close()
  })
})
