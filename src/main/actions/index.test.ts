import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Db } from '../db'
import { clearUndo, dropOutboxSendUndo, recordOutboxSendUndo, undoLast } from '.'

const ACCOUNT = 'outbox-undo@example.com'

afterEach(() => {
  clearUndo(ACCOUNT)
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
