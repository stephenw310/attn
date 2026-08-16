import { describe, expect, it } from 'vitest'
import type { QueueIntent } from './execute'
import { dropRevertedUndoEntries, queueIntentRef, revertedAction } from './revert'

describe('failed-action recovery helpers', () => {
  it('drops an undo entry that references the reverted thread and action only', () => {
    const archiveA = queueIntentRef({ kind: 'modifyLabels', threadId: 'a', add: [], remove: ['INBOX'] }, 1)
    const archiveB = queueIntentRef({ kind: 'modifyLabels', threadId: 'b', add: [], remove: ['INBOX'] }, 2)
    const starA = queueIntentRef({ kind: 'modifyLabels', threadId: 'a', add: ['STARRED'], remove: [] }, 3)
    const entries = [
      { label: 'Archived', refs: [archiveA], undo: [{ threadIds: ['a'] }] },
      { label: 'Starred', refs: [starA], undo: [{ threadIds: ['a'] }] },
      { label: 'Archived', refs: [archiveB], undo: [{ threadIds: ['b'] }] }
    ]

    expect(dropRevertedUndoEntries(entries, [archiveA]).map((entry) => entry.label)).toEqual([
      'Starred',
      'Archived'
    ])
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
      { label: 'Older archive', refs: [older], undo: [{ threadIds: ['a'] }] },
      { label: 'Newer archive', refs: [newer], undo: [{ threadIds: ['a'] }] }
    ]

    expect(dropRevertedUndoEntries(entries, [older]).map((entry) => entry.label)).toEqual(['Newer archive'])
  })

  it('keeps unaffected threads from a bulk action undoable', () => {
    const archiveA = queueIntentRef({ kind: 'modifyLabels', threadId: 'a', add: [], remove: ['INBOX'] }, 1)
    const archiveB = queueIntentRef({ kind: 'modifyLabels', threadId: 'b', add: [], remove: ['INBOX'] }, 2)
    const entries = [
      {
        label: '2 archived',
        refs: [archiveA, archiveB],
        undo: [{ threadIds: ['a'] }, { threadIds: ['b'] }]
      }
    ]

    expect(dropRevertedUndoEntries(entries, [archiveA])).toEqual([
      { label: '2 archived', refs: [archiveB], undo: [{ threadIds: ['b'] }] }
    ])
  })

  it('maps queue deltas to user-facing action names', () => {
    expect(
      revertedAction(
        { kind: 'modifyLabels', threadId: 'a', add: [], remove: ['INBOX'] },
        'Roadmap',
        true,
        'restored'
      )
    ).toEqual({
      threadId: 'a',
      subject: 'Roadmap',
      kind: 'archive',
      returnedToInbox: true,
      resolution: 'restored'
    })
    expect(
      revertedAction(
        { kind: 'modifyLabels', threadId: 'a', add: ['STARRED'], remove: [] },
        'Roadmap',
        true,
        'restored'
      ).kind
    ).toBe('star')
  })

  it('prefers stored user-action metadata over ambiguous label deltas', () => {
    const restore = { kind: 'modifyLabels' as const, threadId: 'a', add: ['INBOX'], remove: [] }
    expect(revertedAction(restore, 'Roadmap', true, 'restored', 'unsnooze').kind).toBe('unsnooze')
    expect(revertedAction(restore, 'Roadmap', true, 'restored', 'undo').kind).toBe('undo')
  })
})
