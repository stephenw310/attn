import { describe, expect, it } from 'vitest'
import { dropRevertedUndoEntries, queueIntentRef, revertedAction } from './revert'

describe('failed-action recovery helpers', () => {
  it('drops an undo entry that references the reverted thread and action only', () => {
    const archiveA = queueIntentRef({
      kind: 'modifyLabels',
      threadId: 'a',
      add: [],
      remove: ['INBOX']
    })
    const archiveB = queueIntentRef({
      kind: 'modifyLabels',
      threadId: 'b',
      add: [],
      remove: ['INBOX']
    })
    const starA = queueIntentRef({
      kind: 'modifyLabels',
      threadId: 'a',
      add: ['STARRED'],
      remove: []
    })
    const entries = [
      { label: 'Archived', refs: [archiveA] },
      { label: 'Starred', refs: [starA] },
      { label: 'Archived', refs: [archiveB] }
    ]

    expect(dropRevertedUndoEntries(entries, [archiveA]).map((entry) => entry.label)).toEqual([
      'Starred',
      'Archived'
    ])
  })

  it('normalizes label order for undo matching', () => {
    expect(
      queueIntentRef({
        kind: 'modifyLabels',
        threadId: 'a',
        add: ['B', 'A'],
        remove: ['D', 'C']
      })
    ).toEqual(
      queueIntentRef({
        kind: 'modifyLabels',
        threadId: 'a',
        add: ['A', 'B'],
        remove: ['C', 'D']
      })
    )
  })

  it('maps queue deltas to user-facing action names', () => {
    expect(
      revertedAction({ kind: 'modifyLabels', threadId: 'a', add: [], remove: ['INBOX'] }, 'Roadmap', true)
    ).toEqual({
      threadId: 'a',
      subject: 'Roadmap',
      kind: 'archive',
      returnedToInbox: true
    })
    expect(
      revertedAction({ kind: 'modifyLabels', threadId: 'a', add: ['STARRED'], remove: [] }, 'Roadmap', true)
        .kind
    ).toBe('star')
  })
})
