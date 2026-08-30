import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { IMPORTANT_SPLIT_ID } from '../../shared/splits'
import { loadSeed } from '../dev/seed'
import { ensureSplitSetup } from '../splits'
import { runFtsBackfill } from '../sync/ftsBackfill'
import { type Db, openDatabase } from './index'
import * as queries from './queries'
import * as search from './search'

// A7's isolation audit as an executable sweep (F18): every read query in
// queries.ts and search.ts runs against a two-account store, and no result
// row may belong to the other account. The export checklist at the bottom is
// the guard — a new read query fails this suite until it is swept here.

const A = 'alpha@attn.test'
const B = 'beta@attn.test'

interface FixtureMessage {
  id: string
  labelIds: string[]
  receivedDaysAgo: number
  from: string
  to: string
  subject: string
  snippet: string
  bodyText: string
}

function accountFixture(prefix: string, extraInbox: boolean): unknown {
  const account = `${prefix}@attn.test`
  const contact = `${prefix.charAt(0).toUpperCase()}${prefix.slice(1)} Contact <contact@${prefix}-only.test>`
  const message = (suffix: string, labelIds: string[], subject: string): FixtureMessage => ({
    id: `m-${prefix}-${suffix}`,
    labelIds,
    receivedDaysAgo: 0,
    from: contact,
    to: account,
    subject,
    snippet: `${prefix} snippet ${suffix}`,
    bodyText: `${prefix} body ${suffix}`
  })
  const thread = (suffix: string, labelIds: string[], subject: string): unknown => ({
    id: `${prefix}-${suffix}`,
    messages: [message(suffix, labelIds, subject)]
  })
  return {
    account,
    labels: [{ id: `${prefix}-label`, name: `${prefix}-label`, type: 'user' }],
    threads: [
      thread('t1', ['INBOX', 'UNREAD', 'IMPORTANT'], `${prefix} roadmap review`),
      thread('t2', ['INBOX', `${prefix}-label`], `${prefix} labeled note`),
      thread('t3', ['SENT'], `${prefix} sent mail`),
      thread('t4', ['INBOX', 'STARRED'], `${prefix} starred pick`),
      thread('t5', ['SPAM'], `${prefix} junk offer`),
      thread('t6', ['TRASH'], `${prefix} trashed memo`),
      thread('t7', [], `${prefix} snoozed roadmap`),
      ...(extraInbox ? [thread('t8', ['INBOX', 'UNREAD'], `${prefix} extra arrival`)] : [])
    ]
  }
}

const dir = mkdtempSync(join(tmpdir(), 'attn-isolation-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

async function twoAccountStore(): Promise<Db> {
  const seedPath = join(dir, 'seed.json')
  writeFileSync(
    seedPath,
    JSON.stringify({ accounts: [accountFixture('alpha', false), accountFixture('beta', true)] })
  )
  const db = openDatabase(':memory:')
  loadSeed(db, seedPath)
  for (const account of [A, B]) {
    db.prepare(
      `INSERT INTO reminders (account_id, thread_id, kind, due_at, state)
       VALUES (?, ?, 'snooze', ?, 'pending')`
    ).run(account, account === A ? 'alpha-t7' : 'beta-t7', Date.now() + 60_000)
    db.prepare(
      `INSERT INTO outbox (
         id, account_id, state, kind, to_json, cc_json, bcc_json, subject, body_html, body_text,
         attachments_json, thread_id, source_message_id, in_reply_to, references_json, quote_html,
         quote_text, created_at, updated_at, local_revision
       ) VALUES (?, ?, 'composing', 'new', '[]', '[]', '[]', ?, '', ?, '[]', NULL, NULL, NULL, '[]',
                 '', '', 1, 1, 1)`
    ).run(`${account}-draft`, account, `${account.split('@')[0]} draft roadmap`, 'draft body')
    db.prepare('UPDATE messages SET attachments_json = ? WHERE account_id = ? AND id = ?').run(
      JSON.stringify([
        { attachmentId: 'att-1', filename: 'x.png', mimeType: 'image/png', inlineData: 'QUJD' }
      ]),
      account,
      account === A ? 'm-alpha-t1' : 'm-beta-t1'
    )
    await runFtsBackfill(db, account, { onProgress: () => {}, onError: () => {} }, { batchPauseMs: 0 })
  }
  return db
}

function onlyAlpha(rows: readonly { id: string }[]): void {
  expect(rows.length).toBeGreaterThan(0)
  for (const row of rows) expect(row.id.startsWith('alpha-'), `${row.id} leaked across accounts`).toBe(true)
}

describe('two-account read isolation', () => {
  it('scopes every list, count, conversation, contact, and search read to its account', async () => {
    const db = await twoAccountStore()

    onlyAlpha(queries.listInboxThreads(db, A))
    ensureSplitSetup(db, A)
    onlyAlpha(queries.listInboxThreads(db, A, queries.THREAD_LIST_LIMIT, null, IMPORTANT_SPLIT_ID))
    for (const view of ['allMail', 'sent', 'starred', 'spam', 'trash'] as const) {
      onlyAlpha(queries.listMailboxThreads(db, A, view))
    }
    onlyAlpha(queries.listLabelThreads(db, A, 'alpha-label'))
    // The other account's label is not even addressable from here.
    expect(queries.listLabelThreads(db, A, 'beta-label')).toEqual([])
    onlyAlpha(queries.listSnoozedThreads(db, A))

    expect(queries.countInboxUnread(db, A)).toBe(1)
    expect(queries.countInboxUnread(db, B)).toBe(2)
    const countsA = queries.countSystemMailboxes(db, A)
    const countsB = queries.countSystemMailboxes(db, B)
    expect(countsA.inbox).toBe(3)
    expect(countsB.inbox).toBe(4)
    expect(queries.listUserLabels(db, A).map((label) => label.id)).toEqual(['alpha-label'])

    expect(queries.getConversation(db, A, 'alpha-t1', 'unavailable')).not.toBeNull()
    expect(queries.getConversation(db, A, 'beta-t1', 'unavailable')).toBeNull()
    expect(queries.getConversationForDisplay(db, A, 'alpha-t1', 'unavailable')).not.toBeNull()
    expect(queries.getConversationForDisplay(db, A, 'beta-t1', 'unavailable')).toBeNull()

    const contacts = queries.searchContacts(db, A, 'contact')
    expect(contacts.length).toBeGreaterThan(0)
    for (const contact of contacts) expect(contact.email.endsWith('@alpha-only.test')).toBe(true)

    expect(queries.getInlineAttachmentData(db, A, 'm-alpha-t1', 'att-1')).toBe('QUJD')
    expect(queries.getInlineAttachmentData(db, A, 'm-beta-t1', 'att-1')).toBeNull()

    // Both accounts' subjects match "roadmap"; only alpha's rows may answer.
    const results = search.searchThreads(db, A, 'roadmap')
    onlyAlpha(results.rows)
    const drafts = search.searchThreads(db, A, 'in:drafts roadmap').drafts
    expect(drafts.length).toBeGreaterThan(0)
    for (const draft of drafts) expect(draft.id).toBe(`${A}-draft`)
    onlyAlpha(search.searchRowsByThreadIds(db, A, ['alpha-t1', 'beta-t1'], 'roadmap'))
    expect(search.matchingStoredThreadIds(db, A, 'roadmap', ['alpha-t1', 'beta-t1'])).toEqual(
      new Set(['alpha-t1'])
    )
    db.close()
  })

  it('sweeps every read export of queries.ts and search.ts (add new reads here)', () => {
    const covered = new Set([
      'listMailboxThreads',
      'listLabelThreads',
      'listInboxThreads',
      'listSnoozedThreads',
      'countSystemMailboxes',
      'listUserLabels',
      'countInboxUnread',
      'getConversation',
      'getConversationForDisplay',
      'searchContacts',
      'getInlineAttachmentData',
      'searchRowsByThreadIds',
      'matchingStoredThreadIds',
      'searchThreads'
    ])
    // Pure SQL-fragment builders take no account and read nothing.
    const exempt = new Set(['allMailMembershipSql', 'labeledMailboxMembershipSql'])
    const exported = [...Object.entries(queries), ...Object.entries(search)]
      .filter(([, value]) => typeof value === 'function')
      .map(([name]) => name)
    for (const name of exported) {
      expect(
        covered.has(name) || exempt.has(name),
        `read query ${name} is not in the two-account isolation sweep`
      ).toBe(true)
    }
    for (const name of covered) expect(exported).toContain(name)
  })
})
