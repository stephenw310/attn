// @vitest-environment jsdom

import { expect, test } from 'vitest'
import type { ThreadRow } from '../../shared/mail'
import {
  applyThreadFlag,
  applyThreadFlagToElement,
  rollbackThreadFlag,
  threadFlagSnapshot
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
