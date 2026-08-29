import { describe, expect, expectTypeOf, it } from 'vitest'
import type { TriageAction } from '../../shared/actions'
import { isTriageAction } from '.'
import { actionLabel, inverseForThread, planAction } from './plan'

describe('triage action planning', () => {
  it('maps archive, spam, and trash to idempotent label deltas', () => {
    expect(planAction({ kind: 'archive', threadIds: ['t1'] })).toEqual({
      add: [],
      remove: ['INBOX'],
      queueKind: 'modifyLabels'
    })
    expect(planAction({ kind: 'spam', threadIds: ['t1'] })).toEqual({
      add: ['SPAM'],
      remove: ['INBOX', 'TRASH'],
      queueKind: 'modifyLabels'
    })
    expect(planAction({ kind: 'trash', threadIds: ['t1'] })).toEqual({
      add: ['TRASH'],
      remove: ['INBOX', 'SPAM'],
      queueKind: 'modifyLabels'
    })
    expect(planAction({ kind: 'untrash', threadIds: ['t1'] })).toEqual({
      add: ['INBOX'],
      remove: ['SPAM', 'TRASH'],
      queueKind: 'modifyLabels'
    })
  })

  it('computes precise toggle and label inverses from pre-state', () => {
    const labels = new Set(['INBOX', 'STARRED', 'keep'])
    expect(inverseForThread({ kind: 'star', threadIds: ['t1'], on: true }, labels, 't1')).toEqual({
      kind: 'star',
      threadIds: ['t1'],
      on: true
    })
    expect(
      inverseForThread(
        { kind: 'label', threadIds: ['t1'], add: ['new'], remove: ['keep', 'missing'] },
        labels,
        't1'
      )
    ).toEqual({ kind: 'label', threadIds: ['t1'], add: ['keep'], remove: ['new'] })
    expect(inverseForThread({ kind: 'trash', threadIds: ['t1'] }, new Set(['SPAM']), 't1')).toEqual({
      kind: 'label',
      threadIds: ['t1'],
      add: ['SPAM'],
      remove: ['TRASH']
    })
    expect(inverseForThread({ kind: 'spam', threadIds: ['t1'] }, new Set(['TRASH']), 't1')).toEqual({
      kind: 'label',
      threadIds: ['t1'],
      add: ['TRASH'],
      remove: ['SPAM']
    })
  })

  it('plans Move separately from label editing and preserves pre-existing destinations on undo', () => {
    const action = {
      kind: 'move' as const,
      threadIds: ['t1'],
      destination: { kind: 'label' as const, labelId: 'Label_Destination' },
      sourceLabelId: 'Label_Source'
    }
    expect(planAction(action)).toEqual({
      add: ['Label_Destination'],
      remove: ['INBOX', 'SPAM', 'TRASH', 'Label_Source'],
      queueKind: 'modifyLabels'
    })
    expect(inverseForThread(action, new Set(['INBOX', 'Label_Source', 'Label_Destination']), 't1')).toEqual({
      kind: 'label',
      threadIds: ['t1'],
      add: ['INBOX', 'Label_Source'],
      remove: []
    })
  })

  it('maps mailbox and split destinations to Gmail system-label deltas', () => {
    const move = (destination: Extract<TriageAction, { kind: 'move' }>['destination']) =>
      planAction({ kind: 'move', threadIds: ['t1'], destination, sourceLabelId: null })

    expect(move({ kind: 'done' })).toMatchObject({ add: [], remove: ['INBOX', 'SPAM', 'TRASH'] })
    expect(move({ kind: 'inbox' })).toMatchObject({ add: ['INBOX'], remove: ['SPAM', 'TRASH'] })
    expect(move({ kind: 'spam' })).toMatchObject({ add: ['SPAM'], remove: ['INBOX', 'TRASH'] })
    expect(move({ kind: 'trash' })).toMatchObject({ add: ['TRASH'], remove: ['INBOX', 'SPAM'] })
    expect(move({ kind: 'important' })).toMatchObject({
      add: ['INBOX', 'IMPORTANT'],
      remove: ['SPAM', 'TRASH']
    })
    expect(move({ kind: 'other' })).toMatchObject({
      add: ['INBOX'],
      remove: ['IMPORTANT', 'SPAM', 'TRASH']
    })
  })

  it('labels the mark-not-done command without renaming ordinary moves', () => {
    const move = {
      kind: 'move' as const,
      threadIds: ['t1'],
      destination: { kind: 'inbox' as const },
      sourceLabelId: null
    }
    expect(actionLabel(move)).toBe('Moved')
    expect(actionLabel({ ...move, verb: 'markNotDone' })).toBe('Marked not done')
    expect(actionLabel({ ...move, threadIds: ['t1', 't2'], verb: 'markNotDone' })).toBe('2 marked not done')
  })

  it('restricts the mark-not-done verb to an Inbox move without a source label', () => {
    expectTypeOf({
      kind: 'move' as const,
      threadIds: ['t1'],
      destination: { kind: 'inbox' as const },
      sourceLabelId: null,
      verb: 'markNotDone' as const
    }).toMatchTypeOf<TriageAction>()
    expectTypeOf({
      kind: 'move' as const,
      threadIds: ['t1'],
      destination: { kind: 'trash' as const },
      sourceLabelId: null,
      verb: 'markNotDone' as const
    }).not.toMatchTypeOf<TriageAction>()
    expectTypeOf({
      kind: 'move' as const,
      threadIds: ['t1'],
      destination: { kind: 'inbox' as const },
      sourceLabelId: 'Label_Source',
      verb: 'markNotDone' as const
    }).not.toMatchTypeOf<TriageAction>()
  })

  it('rejects malformed actions at the IPC boundary', () => {
    expect(isTriageAction({ kind: 'archive', threadIds: ['t1'] })).toBe(true)
    expect(isTriageAction({ kind: 'archive' })).toBe(false)
    expect(isTriageAction({ kind: 'star', threadIds: ['t1'], on: 'yes' })).toBe(false)
    expect(
      isTriageAction({
        kind: 'move',
        threadIds: ['t1'],
        destination: { kind: 'label', labelId: 'Label_Destination' },
        sourceLabelId: null
      })
    ).toBe(true)
    expect(
      isTriageAction({
        kind: 'move',
        threadIds: ['t1'],
        destination: { kind: 'inbox' },
        sourceLabelId: null,
        verb: 'markNotDone'
      })
    ).toBe(true)
    expect(
      isTriageAction({
        kind: 'move',
        threadIds: ['t1'],
        destination: { kind: 'inbox' },
        sourceLabelId: null,
        verb: 'unexpected'
      })
    ).toBe(false)
    expect(
      isTriageAction({
        kind: 'move',
        threadIds: ['t1'],
        destination: { kind: 'trash' },
        sourceLabelId: null,
        verb: 'markNotDone'
      })
    ).toBe(false)
    expect(
      isTriageAction({
        kind: 'move',
        threadIds: ['t1'],
        destination: { kind: 'inbox' },
        sourceLabelId: 'Label_Source',
        verb: 'markNotDone'
      })
    ).toBe(false)
    expect(
      isTriageAction({
        kind: 'move',
        threadIds: ['t1'],
        destination: { kind: 'label', labelId: 'Label_Source' },
        sourceLabelId: 'Label_Source'
      })
    ).toBe(false)
    expect(isTriageAction({ kind: 'unknown', threadIds: ['t1'] })).toBe(false)
  })
})
