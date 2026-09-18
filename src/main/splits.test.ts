import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  IMPORTANT_SPLIT_ID,
  SPLIT_DESCRIPTION_MAX_LENGTH,
  SPLIT_DESCRIPTION_MIN_LENGTH
} from '../shared/splits'
import { type Db, openDatabase } from './db'
import { listInboxThreads } from './db/queries'
import {
  canonicalListId,
  deleteSplit,
  descriptionHash,
  ensureSplitSetup,
  getSplitState,
  normalizeDescription,
  notificationEnabledSplitIds,
  reorderSplits,
  restoreSplitPreset,
  saveSplit,
  splitLocationForThread,
  splitRevision,
  splitTriageCounts
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

  /**
   * A stored classifier answer. `evidenceKey` defaults to a value no message
   * id can equal, so a compiled rule reads it while the triage counts still
   * call the thread unjudged; pass the real message id to answer it for good.
   */
  const insertJudgment = (
    threadId: string,
    splitId: string,
    description: string,
    probability: number,
    evidenceKey = `${threadId}-evidence`
  ): void => {
    db.prepare(
      `INSERT INTO split_judgments
       (account_id, thread_id, split_id, description_hash, evidence_key, probability, judged_at)
       VALUES ('account', ?, ?, ?, ?, ?, 1)`
    ).run(threadId, splitId, descriptionHash(description), evidenceKey, probability)
  }

  const describedSplit = (name: string, description: string): string => {
    const state = saveSplit(db, 'account', { name, mode: 'description', description, notify: false })
    const custom = state.splits.find((split) => split.name === name)
    if (!custom) throw new Error(`Expected split ${name}`)
    return custom.id
  }

  beforeEach(() => {
    db = openDatabase(':memory:')
    db.prepare("INSERT INTO accounts (id, email) VALUES ('account', 'me@test')").run()
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
      mode: 'rules',
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
      mode: 'rules',
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
    expect(notificationEnabledSplitIds(recording, 'account')).toEqual([IMPORTANT_SPLIT_ID])
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

  it('skips malformed stored rules and preserves notification preferences', () => {
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
    expect(notificationEnabledSplitIds(db, 'account')).toEqual([IMPORTANT_SPLIT_ID])
    expect(getSplitState(db, 'account').restorablePresetIds).toContain('preset:github')
    expect(restoreSplitPreset(db, 'account', 'preset:github').restorablePresetIds).not.toContain(
      'preset:github'
    )
  })

  it('collapses description whitespace, keeps case, and rejects lengths outside the limits', () => {
    expect(normalizeDescription('  Anything   from\n\t my  Landlord  ')).toBe('Anything from my Landlord')
    expect(normalizeDescription('Bug')).toBe('Bug')
    const longest = 'a'.repeat(SPLIT_DESCRIPTION_MAX_LENGTH)
    expect(normalizeDescription(longest)).toBe(longest)
    // Too short and too long are both rejected: a long description is never
    // truncated, because a cut question is not the one the user wrote.
    expect(normalizeDescription('ab')).toBeNull()
    expect(normalizeDescription('   ')).toBeNull()
    expect(normalizeDescription('a'.repeat(SPLIT_DESCRIPTION_MAX_LENGTH + 1))).toBeNull()
    expect(() =>
      saveSplit(db, 'account', { name: 'Too short', mode: 'description', description: 'ab', notify: false })
    ).toThrow(`Describe the split in ${SPLIT_DESCRIPTION_MIN_LENGTH} to ${SPLIT_DESCRIPTION_MAX_LENGTH}`)
    expect(() =>
      saveSplit(db, 'account', {
        name: 'Empty',
        mode: 'rules',
        operator: 'any',
        conditions: [],
        notify: false
      })
    ).toThrow('Add at least one complete split condition')
  })

  it('switches a split between the two modes and never keeps both definitions', () => {
    insertThread('vendor', 100, [{ id: 'vendor-message', from: 'alerts@vendor.test' }])
    const splitId = describedSplit('Alerts', 'Something is broken')
    insertJudgment('vendor', splitId, 'Something is broken', 0.95)
    expect(listInboxThreads(db, 'account', 10, null, splitId).map((row) => row.id)).toEqual(['vendor'])

    // Rules mode clears the prose, so the stored judgment stops counting.
    const rules = saveSplit(db, 'account', {
      id: splitId,
      name: 'Alerts',
      mode: 'rules',
      operator: 'any',
      conditions: [{ type: 'senderDomain', value: 'other.test' }],
      notify: false
    })
    const saved = rules.splits.find((split) => split.id === splitId)
    expect(saved?.description).toBeNull()
    expect(saved?.match.conditions).toEqual([{ type: 'senderDomain', value: 'other.test' }])
    expect(listInboxThreads(db, 'account', 10, null, splitId)).toEqual([])

    // A row that carries both is read as described: the prose wins.
    db.prepare("UPDATE split_rules SET description = ? WHERE account_id = 'account' AND id = ?").run(
      'Something is broken',
      splitId
    )
    const described = getSplitState(db, 'account').splits.find((split) => split.id === splitId)
    expect(described?.description).toBe('Something is broken')
    expect(described?.match.conditions).toEqual([])
    expect(listInboxThreads(db, 'account', 10, null, splitId).map((row) => row.id)).toEqual(['vendor'])
  })

  it('counts described splits, judged threads, and the ones still waiting', () => {
    insertThread('judged', 300, [{ id: 'judged-message', from: 'billing@supplier.test' }])
    insertThread('waiting', 200, [{ id: 'waiting-message', from: 'friend@example.com' }])
    // No message at all: the pass cannot judge it, so it is neither judged nor pending.
    db.prepare(
      `INSERT INTO threads
       (account_id, id, subject, snippet, last_msg_at, from_display, is_unread, is_inbox_visible)
       VALUES ('account', 'empty', 'empty', '', 100, '', 0, 1)`
    ).run()
    db.prepare(
      "INSERT INTO thread_labels (account_id, thread_id, label_id) VALUES ('account', 'empty', 'INBOX')"
    ).run()

    expect(splitTriageCounts(db, 'account')).toEqual({
      describedSplits: 0,
      judgedThreads: 0,
      pendingThreads: 0
    })

    const splitId = describedSplit('Invoices', 'Invoices I have to pay')
    expect(splitTriageCounts(db, 'account')).toEqual({
      describedSplits: 1,
      judgedThreads: 0,
      pendingThreads: 2
    })

    // A judgment counts only when it answered this description against the
    // thread's latest message, which is the queue's own definition of current.
    insertJudgment('judged', splitId, 'Invoices I have to pay', 0.1, 'judged-message')
    expect(splitTriageCounts(db, 'account')).toEqual({
      describedSplits: 1,
      judgedThreads: 1,
      pendingThreads: 1
    })

    insertJudgment('waiting', splitId, 'A different question', 0.99, 'waiting-message')
    expect(splitTriageCounts(db, 'account').pendingThreads).toBe(1)
  })

  it('hashes a description through its normalized form and separates different texts', () => {
    const canonical = descriptionHash('Invoices from suppliers')
    expect(canonical).toMatch(/^[0-9a-f]{64}$/)
    expect(descriptionHash('  Invoices   from\n suppliers  ')).toBe(canonical)
    expect(descriptionHash('invoices from suppliers')).not.toBe(canonical)
    expect(descriptionHash('Invoices from customers')).not.toBe(canonical)
  })

  it('saves a description-only rule and claims threads judged at or above the threshold', () => {
    insertThread('judged', 300, [{ id: 'judged-message', from: 'billing@supplier.test' }], true)
    insertThread('unsure', 200, [{ id: 'unsure-message', from: 'friend@example.com' }])
    insertThread('unjudged', 100, [{ id: 'unjudged-message', from: 'stranger@example.com' }])

    const splitId = describedSplit('Invoices', 'Invoices I have to pay')
    insertJudgment('judged', splitId, 'Invoices I have to pay', 0.7)
    insertJudgment('unsure', splitId, 'Invoices I have to pay', 0.69)

    expect(listInboxThreads(db, 'account', 10, null, splitId).map((row) => row.id)).toEqual(['judged'])
    expect(listInboxThreads(db, 'account', 10, null, 'fallback:other').map((row) => row.id)).toEqual([
      'unsure',
      'unjudged'
    ])
    expect(splitLocationForThread(db, 'account', 'judged')?.splitId).toBe(splitId)

    const summary = getSplitState(db, 'account').splits.find((split) => split.id === splitId)
    expect([summary?.total, summary?.unread]).toEqual([1, 1])
  })

  it('ignores a judgment answered against a different description text', () => {
    insertThread('stale', 100, [{ id: 'stale-message', from: 'friend@example.com' }])
    const splitId = describedSplit('Receipts', 'Receipts for things I bought')
    // The judgment is a yes, but it answered the description the split had
    // before the user rewrote it, so the rule must not inherit it.
    insertJudgment('stale', splitId, 'Anything about money', 0.99)

    expect(listInboxThreads(db, 'account', 10, null, splitId)).toEqual([])
    expect(listInboxThreads(db, 'account', 10, null, 'fallback:other').map((row) => row.id)).toEqual([
      'stale'
    ])

    insertJudgment('stale', 'other-split', 'Receipts for things I bought', 0.99)
    expect(listInboxThreads(db, 'account', 10, null, splitId)).toEqual([])
  })

  it('keeps first-match order when two described splits both hold a yes judgment', () => {
    insertThread('contested', 100, [{ id: 'contested-message', from: 'friend@example.com' }])
    const firstId = describedSplit('Urgent', 'Needs an answer today')
    const secondId = describedSplit('Money', 'Anything about money')
    insertJudgment('contested', firstId, 'Needs an answer today', 0.91)
    insertJudgment('contested', secondId, 'Anything about money', 0.99)

    expect(listInboxThreads(db, 'account', 10, null, firstId).map((row) => row.id)).toEqual(['contested'])
    expect(listInboxThreads(db, 'account', 10, null, secondId)).toEqual([])

    reorderSplits(db, 'account', {
      ids: [secondId, firstId, 'preset:calendar', 'preset:github', 'preset:newsletters', IMPORTANT_SPLIT_ID]
    })
    expect(listInboxThreads(db, 'account', 10, null, secondId).map((row) => row.id)).toEqual(['contested'])
    expect(listInboxThreads(db, 'account', 10, null, firstId)).toEqual([])
    const counts = getSplitState(db, 'account').splits
    expect(counts.find((split) => split.id === secondId)?.total).toBe(1)
    expect(counts.find((split) => split.id === firstId)?.total).toBe(0)
  })

  it('canonicalizes folded and bracketed List-Id values', () => {
    expect(canonicalListId(' Product updates <UPDATES.Example.COM> ')).toBe('<updates.example.com>')
    expect(canonicalListId('Weekly.\r\n\tExample.COM')).toBe('weekly. example.com')
    expect(canonicalListId('  ')).toBeNull()
  })
})
