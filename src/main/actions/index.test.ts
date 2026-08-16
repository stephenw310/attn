import { describe, expect, it } from 'vitest'
import type { Db } from '../db'
import { actionQueueStatus, pendingActionCount } from '.'
import { storeActionError } from './execute'

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
