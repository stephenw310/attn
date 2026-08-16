import { describe, expect, it } from 'vitest'
import type { RevertedAction } from '../../shared/actionRevert'
import { ActionRevertNotices } from './revertNotices'

function reverted(threadId: string): RevertedAction {
  return {
    threadId,
    subject: threadId,
    kind: 'archive',
    returnedToInbox: true,
    resolution: 'restored'
  }
}

describe('failed-action notice delivery', () => {
  it('retains ordered account batches until each one is acknowledged', () => {
    const notices = new ActionRevertNotices()
    notices.add('a@example.com', [reverted('a-1')])
    notices.add('b@example.com', [reverted('b-1')])
    notices.add('a@example.com', [reverted('a-2')])

    const firstA = notices.peek('a@example.com')
    expect(firstA?.actions.map((action) => action.threadId)).toEqual(['a-1'])
    expect(notices.peek('a@example.com')).toEqual(firstA)
    expect(notices.acknowledge('a@example.com', firstA?.id ?? -1)).toBe(true)
    const secondA = notices.peek('a@example.com')
    expect(secondA?.actions.map((action) => action.threadId)).toEqual(['a-2'])
    expect(notices.acknowledge('a@example.com', secondA?.id ?? -1)).toBe(true)
    expect(notices.peek('a@example.com')).toBeNull()
    expect(notices.peek('b@example.com')?.actions.map((action) => action.threadId)).toEqual(['b-1'])
  })

  it('does not discard a batch for a stale or duplicate acknowledgement', () => {
    const notices = new ActionRevertNotices()
    notices.add('a@example.com', [reverted('a-1')])
    const notice = notices.peek('a@example.com')

    expect(notices.acknowledge('a@example.com', (notice?.id ?? 0) + 1)).toBe(false)
    expect(notices.peek('a@example.com')).toEqual(notice)
  })

  it('clears only the signed-out account when requested', () => {
    const notices = new ActionRevertNotices()
    notices.add('a@example.com', [reverted('a-1')])
    notices.add('b@example.com', [reverted('b-1')])

    notices.clear('a@example.com')

    expect(notices.peek('a@example.com')).toBeNull()
    expect(notices.peek('b@example.com')?.actions).toHaveLength(1)
  })
})
