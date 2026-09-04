import { describe, expect, it } from 'vitest'
import { isMoveDestination, type MoveDestination, moveLabelDelta } from './move'

const DESTINATIONS: MoveDestination[] = [
  { kind: 'done' },
  { kind: 'inbox' },
  { kind: 'spam' },
  { kind: 'trash' },
  { kind: 'important' },
  { kind: 'other' },
  { kind: 'label', labelId: 'Label_9' }
]

describe('moveLabelDelta', () => {
  it('clears every mailbox marker for Done', () => {
    expect(moveLabelDelta({ kind: 'done' }, null)).toEqual({
      add: [],
      remove: ['INBOX', 'SPAM', 'TRASH']
    })
  })

  it('moves between the mailboxes that exclude one another', () => {
    expect(moveLabelDelta({ kind: 'inbox' }, null)).toEqual({ add: ['INBOX'], remove: ['SPAM', 'TRASH'] })
    expect(moveLabelDelta({ kind: 'spam' }, null)).toEqual({ add: ['SPAM'], remove: ['INBOX', 'TRASH'] })
    expect(moveLabelDelta({ kind: 'trash' }, null)).toEqual({ add: ['TRASH'], remove: ['INBOX', 'SPAM'] })
  })

  it('keeps the thread in the inbox when it changes importance', () => {
    // The split moves are inbox-internal: `useTriage` reads `add`/`remove` to
    // decide whether the row leaves the visible list, and both keep INBOX.
    expect(moveLabelDelta({ kind: 'important' }, null)).toEqual({
      add: ['INBOX', 'IMPORTANT'],
      remove: ['SPAM', 'TRASH']
    })
    expect(moveLabelDelta({ kind: 'other' }, null)).toEqual({
      add: ['INBOX'],
      remove: ['IMPORTANT', 'SPAM', 'TRASH']
    })
  })

  it('files under a label and takes the thread out of the inbox', () => {
    expect(moveLabelDelta({ kind: 'label', labelId: 'Label_9' }, null)).toEqual({
      add: ['Label_9'],
      remove: ['INBOX', 'SPAM', 'TRASH']
    })
  })

  it('removes the label view the move started from', () => {
    // Moving out of a label view has to strip that label, or the thread stays
    // in the list it was just moved out of (`useListActions` passes the view's
    // label id whenever search is closed).
    for (const destination of DESTINATIONS) {
      expect(moveLabelDelta(destination, 'Label_1').remove, destination.kind).toContain('Label_1')
    }
    expect(moveLabelDelta({ kind: 'label', labelId: 'Label_9' }, 'Label_1')).toEqual({
      add: ['Label_9'],
      remove: ['INBOX', 'SPAM', 'TRASH', 'Label_1']
    })
  })

  it('never asks Gmail to both add and remove the same label', () => {
    for (const destination of DESTINATIONS) {
      for (const source of [null, 'Label_1']) {
        const delta = moveLabelDelta(destination, source)
        const overlap = delta.add.filter((labelId) => delta.remove.includes(labelId))
        expect(overlap, `${destination.kind}/${source}`).toEqual([])
      }
    }
  })

  it('lists each label once when the source repeats a mailbox marker', () => {
    expect(moveLabelDelta({ kind: 'done' }, 'INBOX').remove).toEqual(['INBOX', 'SPAM', 'TRASH'])
    expect(moveLabelDelta({ kind: 'spam' }, 'TRASH').remove).toEqual(['INBOX', 'TRASH'])
  })
})

describe('isMoveDestination', () => {
  it('accepts every destination the picker can produce', () => {
    for (const destination of DESTINATIONS) expect(isMoveDestination(destination)).toBe(true)
  })

  it('rejects malformed values crossing the bridge', () => {
    expect(isMoveDestination(null)).toBe(false)
    expect(isMoveDestination('inbox')).toBe(false)
    expect(isMoveDestination({})).toBe(false)
    expect(isMoveDestination({ kind: 'archive' })).toBe(false)
    expect(isMoveDestination({ kind: 'label' })).toBe(false)
    expect(isMoveDestination({ kind: 'label', labelId: '' })).toBe(false)
    expect(isMoveDestination({ kind: 'label', labelId: 42 })).toBe(false)
  })
})
