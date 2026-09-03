import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { IMPORTANT_SPLIT_ID } from '../shared/splits'
import { type Db, openDatabase } from './db'
import { listInboxThreads } from './db/queries'
import {
  canonicalListId,
  countNotificationEnabledUnread,
  deleteSplit,
  ensureSplitSetup,
  getSplitState,
  reorderSplits,
  restoreSplitPreset,
  saveSplit,
  splitLocationForThread,
  splitRevision
} from './splits'

describe('split inbox', () => {
  let db: Db

  const insertThread = (
    id: string,
    at: number,
    messages: {
      id: string
      from?: string
      labels?: string[]
      listId?: string | null
      attachments?: unknown[]
      calendar?: boolean
    }[],
    unread = false
  ): void => {
    db.prepare(
      `INSERT INTO threads
       (account_id, id, subject, snippet, last_msg_at, from_display, is_unread, is_inbox_visible)
       VALUES ('account', ?, ?, '', ?, ?, ?, 1)`
    ).run(id, id, at, messages.at(-1)?.from ?? '', unread ? 1 : 0)
    db.prepare(
      `INSERT INTO thread_labels (account_id, thread_id, label_id)
       VALUES ('account', ?, 'INBOX')`
    ).run(id)
    const insertMessage = db.prepare(
      `INSERT INTO messages
       (account_id, id, thread_id, from_email, internal_date, attachments_json, labels_json,
        list_id, has_calendar_part)
       VALUES ('account', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    messages.forEach((message, index) => {
      insertMessage.run(
        message.id,
        id,
        message.from ?? '',
        at + index,
        JSON.stringify(message.attachments ?? []),
        JSON.stringify(message.labels ?? []),
        message.listId ?? null,
        message.calendar ? 1 : 0
      )
    })
  }

  beforeEach(() => {
    db = openDatabase(':memory:')
    db.prepare("INSERT INTO accounts (id, email, created_at) VALUES ('account', 'me@test', 0)").run()
  })

  afterEach(() => db.close())

  it('seeds editable presets once and assigns every Inbox thread to one ordered split', () => {
    insertThread(
      'github-newsletter',
      500,
      [{ id: 'm-github', from: 'updates@github.com', listId: 'product.example' }],
      true
    )
    insertThread('calendar', 400, [{ id: 'm-calendar', from: 'someone@test', calendar: true }], true)
    insertThread('newsletter', 300, [{ id: 'm-newsletter', listId: 'weekly.example' }])
    insertThread('important', 200, [{ id: 'm-important', labels: ['IMPORTANT'] }], true)
    insertThread('other', 100, [{ id: 'm-other', from: 'friend@example.com' }])

    const state = getSplitState(db, 'account')
    expect(state.revision).toBe(1)
    expect(state.splits.map((split) => [split.id, split.total, split.unread])).toEqual([
      ['preset:calendar', 1, 1],
      ['preset:github', 1, 1],
      ['preset:newsletters', 1, 0],
      [IMPORTANT_SPLIT_ID, 1, 1],
      ['fallback:other', 1, 0]
    ])
    expect(listInboxThreads(db, 'account', 100, null, 'preset:github').map((row) => row.id)).toEqual([
      'github-newsletter'
    ])
    expect(splitLocationForThread(db, 'account', 'github-newsletter')).toEqual({
      splitId: 'preset:github',
      revision: state.revision
    })
    const assigned = state.splits.flatMap((split) =>
      listInboxThreads(db, 'account', 100, null, split.id).map((row) => row.id)
    )
    expect(assigned.sort()).toEqual(['calendar', 'github-newsletter', 'important', 'newsletter', 'other'])
  })

  it('keeps all conditions on the same message and pages inside the selected split', () => {
    insertThread('same', 300, [{ id: 'same-message', from: 'same@github.com', labels: ['IMPORTANT'] }])
    insertThread('cross', 200, [
      { id: 'cross-sender', from: 'sender@github.com' },
      { id: 'cross-label', from: 'other@example.com', labels: ['IMPORTANT'] }
    ])
    insertThread('same-older', 100, [
      { id: 'same-older-message', from: 'older@github.com', labels: ['IMPORTANT'] }
    ])

    const saved = saveSplit(db, 'account', {
      name: 'GitHub important',
      operator: 'all',
      conditions: [
        { type: 'senderDomain', value: 'GitHub.com' },
        { type: 'label', value: 'IMPORTANT' }
      ],
      notify: false
    })
    const custom = saved.splits.find((split) => split.kind === 'custom')
    if (!custom) throw new Error('Expected custom split')
    reorderSplits(db, 'account', {
      ids: [custom.id, 'preset:calendar', 'preset:github', 'preset:newsletters', IMPORTANT_SPLIT_ID]
    })

    const first = listInboxThreads(db, 'account', 1, null, custom.id)
    expect(first.map((row) => row.id)).toEqual(['same'])
    expect(
      listInboxThreads(db, 'account', 1, { at: first[0].lastMsgAt, id: first[0].id }, custom.id).map(
        (row) => row.id
      )
    ).toEqual(['same-older'])
    expect(listInboxThreads(db, 'account', 10, null, 'preset:github').map((row) => row.id)).toEqual(['cross'])
  })

  it('stops evaluating old messages once the requested recent split page is full', () => {
    for (let index = 0; index < 50; index++) {
      insertThread(`old-${index}`, index + 1, [{ id: `old-message-${index}`, from: 'old@query.test' }])
    }
    for (let index = 1; index <= 3; index++) {
      insertThread(`recent-${index}`, index * 100, [
        { id: `recent-message-${index}`, from: 'new@query.test' }
      ])
    }
    const state = saveSplit(db, 'account', {
      name: 'Query test',
      operator: 'any',
      conditions: [{ type: 'senderDomain', value: 'query.test' }],
      notify: false
    })
    const custom = state.splits.find((split) => split.kind === 'custom')
    if (!custom) throw new Error('Expected custom split')
    let oldMessageEvaluations = 0
    db.function('lower', { deterministic: true }, (value: unknown) => {
      if (value === 'old@query.test') oldMessageEvaluations++
      return String(value ?? '').toLowerCase()
    })

    expect(listInboxThreads(db, 'account', 2, null, custom.id).map((row) => row.id)).toEqual([
      'recent-3',
      'recent-2'
    ])
    expect(oldMessageEvaluations).toBe(0)
  })

  it('reads splits without writing', () => {
    // Every Inbox page, badge count and thread focus reads the split rules.
    // Seeding them from those readers opened a write transaction on each one.
    insertThread('other', 100, [{ id: 'm-other', from: 'friend@example.com' }], true)
    getSplitState(db, 'account')
    const statements: string[] = []
    const recording = new Proxy(db, {
      get(target, property, receiver) {
        if (property === 'prepare') {
          return (sql: string) => {
            statements.push(sql)
            return target.prepare(sql)
          }
        }
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      }
    }) as Db

    expect(splitRevision(recording, 'account')).toBe(1)
    expect(listInboxThreads(recording, 'account', 10, null, 'fallback:other').map((row) => row.id)).toEqual([
      'other'
    ])
    expect(countNotificationEnabledUnread(recording, 'account')).toBe(0)
    expect(splitLocationForThread(recording, 'account', 'other')).toEqual({
      splitId: 'fallback:other',
      revision: 1
    })

    expect(statements.filter((sql) => /^\s*(insert|update|delete)/i.test(sql))).toEqual([])
  })

  it('does not recreate deleted presets and restores only the requested preset', () => {
    ensureSplitSetup(db, 'account')
    const initialRevision = splitRevision(db, 'account')
    deleteSplit(db, 'account', 'preset:github')
    deleteSplit(db, 'account', 'preset:calendar')
    ensureSplitSetup(db, 'account')
    const deleted = getSplitState(db, 'account')
    expect(deleted.splits.map((split) => split.id)).not.toContain('preset:github')
    expect(deleted.splits.map((split) => split.id)).not.toContain('preset:calendar')
    expect(deleted.restorablePresetIds).toEqual(['preset:calendar', 'preset:github'])
    expect(deleted.revision).toBe(initialRevision + 2)

    const restored = restoreSplitPreset(db, 'account', 'preset:github')
    expect(restored.splits.map((split) => split.id)).toContain('preset:github')
    expect(restored.splits.map((split) => split.id)).not.toContain('preset:calendar')
    expect(restored.restorablePresetIds).toEqual(['preset:calendar'])
  })

  it('skips malformed stored rules and counts unread mail only in notifying splits', () => {
    insertThread('github', 200, [{ id: 'github-message', from: 'updates@github.com' }], true)
    insertThread('important', 100, [{ id: 'important-message', labels: ['IMPORTANT'] }], true)
    getSplitState(db, 'account')
    db.prepare(
      `UPDATE split_rules SET match_json = '{"version":2}'
       WHERE account_id = 'account' AND id = 'preset:github'`
    ).run()

    expect(listInboxThreads(db, 'account', 10, null, 'preset:github')).toEqual([])
    expect(listInboxThreads(db, 'account', 10, null, 'fallback:other').map((row) => row.id)).toEqual([
      'github'
    ])
    expect(countNotificationEnabledUnread(db, 'account')).toBe(1)
    expect(getSplitState(db, 'account').restorablePresetIds).toContain('preset:github')
    expect(restoreSplitPreset(db, 'account', 'preset:github').restorablePresetIds).not.toContain(
      'preset:github'
    )
  })

  it('canonicalizes folded and bracketed List-Id values', () => {
    expect(canonicalListId(' Product updates <UPDATES.Example.COM> ')).toBe('<updates.example.com>')
    expect(canonicalListId('Weekly.\r\n\tExample.COM')).toBe('weekly. example.com')
    expect(canonicalListId('  ')).toBeNull()
  })
})
