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
  body?: string
  labels?: string[]
  references?: string[] | null
  account?: string
}

function addMessage(db: Db, patch: Patch): void {
  db.prepare(
    `INSERT INTO messages (account_id, id, thread_id, internal_date, body_text, labels_json, references_json)
     VALUES (?, ?, 't', ?, ?, ?, ?)`
  ).run(
    patch.account ?? ACCOUNT,
    patch.id,
    patch.internalDate,
    patch.body ?? `body of ${patch.id}`,
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
    const examples = listStyleExamples(db, ACCOUNT)
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
    expect(listStyleExamples(db, ACCOUNT)).toEqual(['body of m-good'])
  })

  it('bounds each example to the disclosed excerpt size', () => {
    const db = store()
    addMessage(db, { id: 'm-long', internalDate: 1_000, body: 'x'.repeat(STYLE_EXAMPLE_MAX_CHARS + 500) })
    const [example] = listStyleExamples(db, ACCOUNT)
    expect(example).toHaveLength(STYLE_EXAMPLE_MAX_CHARS)
  })
})
