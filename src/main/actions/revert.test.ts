import { describe, expect, it } from 'vitest'
import type { QueueIntent } from './execute'
import { dropRevertedUndoEntries, queueIntentRef, revertedAction } from './revert'

describe('failed-action recovery helpers', () => {
  it('drops an undo entry that references the reverted thread and action only', () => {
    const archiveA = queueIntentRef({ kind: 'modifyLabels', threadId: 'a', add: [], remove: ['INBOX'] }, 1)
    const archiveB = queueIntentRef({ kind: 'modifyLabels', threadId: 'b', add: [], remove: ['INBOX'] }, 2)
    const starA = queueIntentRef({ kind: 'modifyLabels', threadId: 'a', add: ['STARRED'], remove: [] }, 3)
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
      queueIntentRef({ kind: 'modifyLabels', threadId: 'a', add: ['B', 'A'], remove: ['D', 'C'] }, 1)
    ).toEqual(queueIntentRef({ kind: 'modifyLabels', threadId: 'a', add: ['A', 'B'], remove: ['C', 'D'] }, 1))
  })

  it('keeps a newer identical action undoable when an older queue row reverts', () => {
    const intent: QueueIntent = {
      kind: 'modifyLabels',
      threadId: 'a',
      add: [],
      remove: ['INBOX']
    }
    const older = queueIntentRef(intent, 10)
    const newer = queueIntentRef(intent, 11)
    const entries = [
      { label: 'Older archive', refs: [older] },
      { label: 'Newer archive', refs: [newer] }
    ]

    expect(dropRevertedUndoEntries(entries, [older]).map((entry) => entry.label)).toEqual(['Newer archive'])
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
