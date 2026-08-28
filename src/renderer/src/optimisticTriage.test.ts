// @vitest-environment jsdom

import { expect, test } from 'vitest'
import type { TriageAction } from '../../shared/actions'
import type { ThreadRow } from '../../shared/mail'
import {
  applyThreadFlag,
  applyThreadFlagToElement,
  applyThreadMove,
  applyThreadMoveMembership,
  movedThreadIdsOutsideView,
  moveExitsView,
  rollbackThreadFlag,
  rollbackThreadMove,
  rollbackThreadMoveMembership,
  selectionAfterExit,
  threadFlagSnapshot,
  threadMoveSnapshot
} from './optimisticTriage'

function row(id: string, unread: boolean, starred: boolean): ThreadRow {
  return {
    id,
    fromDisplay: 'Sender',
    subject: 'Subject',
    snippet: 'Snippet',
    lastMsgAt: 1,
    unread,
    starred,
    hasAttachment: false,
    snoozed: false,
    returned: false,
    hasDraft: false,
    labelIds: []
  }
}

test('applies and rolls back star feedback without touching untargeted rows', () => {
  const rows = [row('one', false, false), row('two', true, true)]
  const snapshot = threadFlagSnapshot({ kind: 'star', threadIds: ['one'], on: true }, rows)
  expect(snapshot).not.toBeNull()
  if (!snapshot) return

  const optimistic = applyThreadFlag(rows, snapshot)
  expect(optimistic?.map(({ id, starred }) => ({ id, starred }))).toEqual([
    { id: 'one', starred: true },
    { id: 'two', starred: true }
  ])
  expect(optimistic?.[1]).toBe(rows[1])
  expect(rollbackThreadFlag(optimistic, snapshot)).toEqual(rows)
})

test('does not let an older rollback overwrite a newer flag action', () => {
  const rows = [row('one', false, false)]
  const first = threadFlagSnapshot({ kind: 'markUnread', threadIds: ['one'], on: true }, rows)
  expect(first).not.toBeNull()
  if (!first) return
  const afterFirst = applyThreadFlag(rows, first)
  const second = threadFlagSnapshot({ kind: 'markUnread', threadIds: ['one'], on: false }, afterFirst ?? [])
  expect(second).not.toBeNull()
  if (!second) return
  const afterSecond = applyThreadFlag(afterFirst, second)

  expect(rollbackThreadFlag(afterSecond, first)?.[0].unread).toBe(false)
  expect(rollbackThreadFlag(afterSecond, second)?.[0].unread).toBe(true)
})

test('updates the focused row data attribute synchronously', () => {
  const element = document.createElement('div')
  element.dataset.threadId = 'one'
  const snapshot = threadFlagSnapshot({ kind: 'markUnread', threadIds: ['one'], on: true }, [
    row('one', false, false)
  ])
  expect(snapshot).not.toBeNull()
  if (!snapshot) return

  applyThreadFlagToElement(element, snapshot)
  expect(element.dataset.unread).toBe('true')
  applyThreadFlagToElement(element, snapshot, true)
  expect(element.dataset.unread).toBeUndefined()
})

test('applies and exactly rolls back move labels and snooze state', () => {
  const rows = [
    {
      ...row('one', false, false),
      labelIds: ['INBOX', 'source', 'keep'],
      snoozed: true,
      returned: true
    },
    row('two', true, true)
  ]
  const snapshot = threadMoveSnapshot(
    {
      kind: 'move',
      threadIds: ['one'],
      destination: { kind: 'label', labelId: 'destination' },
      sourceLabelId: 'source'
    },
    rows
  )
  expect(snapshot).not.toBeNull()
  if (!snapshot) return

  const optimistic = applyThreadMove(rows, snapshot)
  expect(optimistic?.[0]).toMatchObject({
    labelIds: ['keep', 'destination'],
    snoozed: false,
    returned: false
  })
  expect(optimistic?.[1]).toBe(rows[1])
  expect(rollbackThreadMove(optimistic, snapshot)).toEqual(rows)
})

test('does not let an older move rollback overwrite newer move state', () => {
  const rows = [{ ...row('one', false, false), labelIds: ['INBOX'] }]
  const first = threadMoveSnapshot(
    {
      kind: 'move',
      threadIds: ['one'],
      destination: { kind: 'label', labelId: 'first' },
      sourceLabelId: null
    },
    rows
  )
  expect(first).not.toBeNull()
  if (!first) return
  const afterFirst = applyThreadMove(rows, first)
  const second = threadMoveSnapshot(
    {
      kind: 'move',
      threadIds: ['one'],
      destination: { kind: 'label', labelId: 'second' },
      sourceLabelId: null
    },
    afterFirst ?? []
  )
  expect(second).not.toBeNull()
  if (!second) return
  const afterSecond = applyThreadMove(afterFirst, second)

  expect(rollbackThreadMove(afterSecond, first)?.[0].labelIds).toEqual(['first', 'second'])
  expect(rollbackThreadMove(afterSecond, second)?.[0].labelIds).toEqual(['first'])
})

test('removes moved rows from an inactive cache and restores their exact position on rejection', () => {
  const rows = [
    { ...row('one', false, false), labelIds: ['INBOX', 'keep'] },
    { ...row('two', true, true), labelIds: ['INBOX'] }
  ]
  const snapshot = threadMoveSnapshot(
    {
      kind: 'move',
      threadIds: ['one'],
      destination: { kind: 'label', labelId: 'destination' },
      sourceLabelId: null
    },
    rows
  )
  expect(snapshot).not.toBeNull()
  if (!snapshot) return

  const optimistic = applyThreadMoveMembership(rows, snapshot, (candidate) =>
    candidate.labelIds.includes('INBOX')
  )
  expect(optimistic?.map((candidate) => candidate.id)).toEqual(['two'])
  expect(rollbackThreadMoveMembership(optimistic, rows, snapshot)).toEqual(rows)
})

test('computes search exits from each row after the Move delta', () => {
  const rows = [
    { ...row('one', false, false), labelIds: ['INBOX'] },
    { ...row('two', false, false), labelIds: ['INBOX', 'keep'] }
  ]
  const snapshot = threadMoveSnapshot(
    {
      kind: 'move',
      threadIds: ['one', 'two'],
      destination: { kind: 'label', labelId: 'destination' },
      sourceLabelId: null
    },
    rows
  )
  expect(snapshot).not.toBeNull()
  if (!snapshot) return

  expect(
    movedThreadIdsOutsideView(rows, snapshot, (candidate) => candidate.labelIds.includes('keep'))
  ).toEqual(['one'])
})

test('moves exit each changed mailbox and built-in split', () => {
  const move: TriageAction = {
    kind: 'move',
    threadIds: ['one'],
    destination: { kind: 'label', labelId: 'destination' },
    sourceLabelId: 'source'
  }
  expect(moveExitsView(move, 'inbox')).toBe(true)
  expect(moveExitsView(move, 'label:source')).toBe(true)
  expect(moveExitsView(move, 'allMail')).toBe(false)
  expect(
    moveExitsView(
      { kind: 'move', threadIds: ['one'], destination: { kind: 'inbox' }, sourceLabelId: null },
      'spam'
    )
  ).toBe(true)
  expect(
    moveExitsView(
      { kind: 'move', threadIds: ['one'], destination: { kind: 'spam' }, sourceLabelId: null },
      'spam'
    )
  ).toBe(false)
  expect(
    moveExitsView(
      { kind: 'move', threadIds: ['one'], destination: { kind: 'trash' }, sourceLabelId: null },
      'allMail'
    )
  ).toBe(true)
  expect(
    moveExitsView(
      { kind: 'move', threadIds: ['one'], destination: { kind: 'other' }, sourceLabelId: null },
      'inbox',
      'base:important'
    )
  ).toBe(true)
  expect(
    moveExitsView(
      { kind: 'move', threadIds: ['one'], destination: { kind: 'important' }, sourceLabelId: null },
      'inbox',
      'fallback:other'
    )
  ).toBe(true)
  expect(moveExitsView({ kind: 'archive', threadIds: ['one'] }, 'inbox')).toBe(false)
})

test('chooses the next surviving row, then falls back above the removed block', () => {
  const rows = ['one', 'two', 'three', 'four'].map((id) => ({ id }))
  expect(selectionAfterExit(rows, ['one'], 0)).toEqual({ fromId: 'one', toId: 'two', nextIndex: 1 })
  expect(selectionAfterExit(rows, ['two', 'three'], 1)).toEqual({
    fromId: 'two',
    toId: 'four',
    nextIndex: 3
  })
  expect(selectionAfterExit(rows, ['three', 'four'], 3)).toEqual({
    fromId: 'four',
    toId: 'two',
    nextIndex: 1
  })
})
