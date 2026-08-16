import { describe, expect, it } from 'vitest'
import type { RevertedAction } from '../../shared/actionRevert'
import { ActionRevertNotices } from './revertNotices'

function reverted(threadId: string): RevertedAction {
  return { threadId, subject: threadId, kind: 'archive', returnedToInbox: true }
}

describe('failed-action notice delivery', () => {
  it('batches notices until each account consumes them exactly once', () => {
    const notices = new ActionRevertNotices()
    notices.add('a@example.com', [reverted('a-1')])
    notices.add('b@example.com', [reverted('b-1')])
    notices.add('a@example.com', [reverted('a-2')])

    expect(notices.take('a@example.com').map((action) => action.threadId)).toEqual(['a-1', 'a-2'])
    expect(notices.take('a@example.com')).toEqual([])
    expect(notices.take('b@example.com').map((action) => action.threadId)).toEqual(['b-1'])
  })

  it('clears only the signed-out account when requested', () => {
    const notices = new ActionRevertNotices()
    notices.add('a@example.com', [reverted('a-1')])
    notices.add('b@example.com', [reverted('b-1')])

    notices.clear('a@example.com')

    expect(notices.take('a@example.com')).toEqual([])
    expect(notices.take('b@example.com')).toHaveLength(1)
  })
})
