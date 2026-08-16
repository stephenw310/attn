import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../db'
import {
  actionQueueStatus,
  clearUndo,
  dropOutboxSendUndo,
  pendingActionCount,
  recordOutboxSendUndo,
  undoLast
} from '.'
import { storeActionError } from './execute'

const ACCOUNT = 'outbox-undo@example.com'

afterEach(() => {
  clearUndo(ACCOUNT)
})

function queueDb(lastErrors: Array<string | null>): Db {
  return {
    prepare: () => ({
      all: () => lastErrors.map((last_error) => ({ last_error })),
      get: () => ({ count: lastErrors.length })
    })
  } as unknown as Db
}

describe('action queue status', () => {
  it('keeps legacy failed rows visible in the pending count', () => {
    const db = queueDb([null])
    expect(pendingActionCount(db, 'a@example.com')).toBe(1)
  })

  it('surfaces typed auth pauses separately from ordinary pending work', () => {
    const db = queueDb([null, storeActionError(new Error('revoked'), 'auth')])
    expect(actionQueueStatus(db, 'a@example.com')).toEqual({ pending: 2, authPaused: true })
  })
})

describe('outbox undo stack', () => {
  it('reopens only a row that is still queued', () => {
    const run = vi.fn(() => ({ changes: 1 }))
    const db = { prepare: vi.fn(() => ({ run })) } as unknown as Db
    recordOutboxSendUndo(ACCOUNT, 'outbox-1')

    expect(undoLast(db, ACCOUNT)).toEqual({ label: 'Send undone', reopenDraftId: 'outbox-1' })
    expect(run).toHaveBeenCalledWith(expect.any(Number), ACCOUNT, 'outbox-1')
  })

  it('reports an already-fired send and consumes that undo entry', () => {
    const db = {
      prepare: vi.fn(() => ({ run: vi.fn(() => ({ changes: 0 })) }))
    } as unknown as Db
    recordOutboxSendUndo(ACCOUNT, 'outbox-1')

    expect(undoLast(db, ACCOUNT)).toEqual({ label: 'Already sent' })
    expect(undoLast(db, ACCOUNT)).toBeNull()
  })

  it('drops the stale send entry when a failed message is reopened explicitly', () => {
    const db = { prepare: vi.fn() } as unknown as Db
    recordOutboxSendUndo(ACCOUNT, 'outbox-1')
    dropOutboxSendUndo(ACCOUNT, 'outbox-1')

    expect(undoLast(db, ACCOUNT)).toBeNull()
  })
})
