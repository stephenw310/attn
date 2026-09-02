import { describe, expect, it } from 'vitest'
import { type Db, openDatabase } from '../db'
import { listStyleExamples, STYLE_EXAMPLE_COUNT, STYLE_EXAMPLE_MAX_CHARS } from './styleExamples'

const ACCOUNT = 'user@attn.test'

function store(): Db {
  const db = openDatabase(':memory:')
  db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, 0)').run(ACCOUNT, ACCOUNT)
  return db
}

interface Patch {
  id: string
  internalDate: number
  body?: string | null
  html?: string
  labels?: string[]
  references?: string[] | null
  account?: string
  threadId?: string
}

function addMessage(db: Db, patch: Patch): void {
  db.prepare(
    `INSERT INTO messages (account_id, id, thread_id, internal_date, body_text, body_html, labels_json, references_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    patch.account ?? ACCOUNT,
    patch.id,
    patch.threadId ?? 't',
    patch.internalDate,
    patch.body === undefined ? `body of ${patch.id}` : patch.body,
    patch.html ?? null,
    JSON.stringify(patch.labels ?? ['SENT']),
    patch.references === null ? null : JSON.stringify(patch.references ?? ['<x@attn.test>'])
  )
}

describe('listStyleExamples', () => {
  it('returns the newest sent replies first, capped at the example count', () => {
    const db = store()
    for (let index = 1; index <= STYLE_EXAMPLE_COUNT + 2; index++) {
      addMessage(db, { id: `m-${index}`, internalDate: index * 1_000 })
    }
    const examples = listStyleExamples(db, ACCOUNT, 'current-thread')
    expect(examples).toHaveLength(STYLE_EXAMPLE_COUNT)
    expect(examples[0]).toBe('body of m-5')
    expect(examples[1]).toBe('body of m-4')
  })

  it('includes only the user’s own sent replies', () => {
    const db = store()
    addMessage(db, { id: 'm-inbound', internalDate: 9_000, labels: ['INBOX'] })
    addMessage(db, { id: 'm-draft', internalDate: 8_000, labels: ['SENT', 'DRAFT'] })
    addMessage(db, { id: 'm-not-reply', internalDate: 7_000, references: null })
    addMessage(db, { id: 'm-empty', internalDate: 6_000, body: '   ' })
    addMessage(db, { id: 'm-good', internalDate: 5_000 })
    db.prepare("INSERT INTO accounts (id, email, created_at) VALUES ('other@attn.test', 'o', 0)").run()
    addMessage(db, { id: 'm-other-account', internalDate: 4_000, account: 'other@attn.test' })
    expect(listStyleExamples(db, ACCOUNT, 'current-thread')).toEqual(['body of m-good'])
  })

  it('bounds each example to the disclosed excerpt size', () => {
    const db = store()
    addMessage(db, { id: 'm-long', internalDate: 1_000, body: 'x'.repeat(STYLE_EXAMPLE_MAX_CHARS + 500) })
    const [example] = listStyleExamples(db, ACCOUNT, 'current-thread')
    expect(example).toHaveLength(STYLE_EXAMPLE_MAX_CHARS)
  })

  it('excludes the conversation being answered before applying the candidate limit', () => {
    const db = store()
    addMessage(db, { id: 'unrelated-reply', internalDate: 1, threadId: 'other-thread' })
    for (let index = 0; index < 201; index++) {
      addMessage(db, {
        id: `later-reply-${index}`,
        internalDate: index + 2,
        threadId: 'current-thread',
        body: 'Later internal discussion, including quoted email history.'
      })
    }
    expect(listStyleExamples(db, ACCOUNT, 'current-thread')).toEqual(['body of unrelated-reply'])
  })

  it('uses authored text, skipping quote-only and signature-only candidates before counting examples', () => {
    const db = store()
    addMessage(db, {
      id: 'quote-only',
      internalDate: 9_000,
      body: 'Other writing',
      html: '<blockquote>Other writing</blockquote>'
    })
    addMessage(db, { id: 'signature-only', internalDate: 8_000, body: '-- \nMy signature' })
    addMessage(db, {
      id: 'html',
      internalDate: 7_000,
      body: 'HTML answer. Flattened quote. My signature.',
      html: '<p>HTML answer.</p><div class="gmail_signature">My signature.</div><blockquote>Flattened quote.</blockquote>'
    })
    addMessage(db, {
      id: 'plain',
      internalDate: 6_000,
      body: 'Plain answer.\n\nOn Monday, Maya wrote:\nQuoted history.'
    })
    addMessage(db, { id: 'html-only', internalDate: 5_000, body: null, html: '<p>HTML-only answer.</p>' })
    expect(listStyleExamples(db, ACCOUNT, 'current-thread')).toEqual([
      'HTML answer.',
      'Plain answer.',
      'HTML-only answer.'
    ])
  })
})
