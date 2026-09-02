import { describe, expect, it, vi } from 'vitest'
import { type Db, openDatabase } from '../db'
import {
  listStyleExamples,
  STYLE_EXAMPLE_COUNT,
  STYLE_EXAMPLE_MAX_CHARS,
  STYLE_EXAMPLES_MAX_TOTAL_INPUT_BYTES
} from './styleExamples'
import { STYLE_EXAMPLE_MAX_INPUT_BYTES } from './styleText'

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

/** Measure actual SQLite result payloads, before extraction could hide an oversized read. */
function trackBodyReads(db: Db): number[] {
  const sizes: number[] = []
  const record = (row: unknown): void => {
    if (!row || typeof row !== 'object') return
    const body = row as { body_text?: string | null; body_html?: string | null }
    sizes.push(Buffer.byteLength(body.body_text ?? '') + Buffer.byteLength(body.body_html ?? ''))
  }
  const prepare = db.prepare.bind(db)
  vi.spyOn(db, 'prepare').mockImplementation((sql) => {
    const statement = prepare(sql)
    const all = statement.all.bind(statement)
    const get = statement.get.bind(statement)
    vi.spyOn(statement, 'all').mockImplementation((...args: unknown[]) => {
      const rows = all(...args)
      rows.forEach(record)
      return rows
    })
    vi.spyOn(statement, 'get').mockImplementation((...args: unknown[]) => {
      const row = get(...args)
      record(row)
      return row
    })
    return statement
  })
  return sizes
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

  it('skips oversized body alternatives and still finds older usable examples', () => {
    const db = store()
    addMessage(db, {
      id: 'large-html',
      internalDate: 4,
      body: 'Unsafe fallback',
      html: `<p>Oversized example.</p><blockquote>${'x'.repeat(2_000_000)}</blockquote>`
    })
    addMessage(db, {
      id: 'large-plain',
      internalDate: 3,
      body: `Oversized text.\n> ${'x'.repeat(2_000_000)}`
    })
    addMessage(db, {
      id: 'large-unicode',
      internalDate: 2,
      body: 'é'.repeat(STYLE_EXAMPLE_MAX_INPUT_BYTES / 2 + 1)
    })
    addMessage(db, { id: 'small', internalDate: 1, body: 'A usable answer.' })
    const readSizes = trackBodyReads(db)
    expect(listStyleExamples(db, ACCOUNT, 'current-thread')).toEqual(['A usable answer.'])
    expect(readSizes.reduce((sum, size) => sum + size, 0)).toBe(Buffer.byteLength('A usable answer.'))
  })

  it('stops loading bodies when quote-only candidates exhaust the total input budget', () => {
    const db = store()
    const quote = `<blockquote>${'x'.repeat(STYLE_EXAMPLE_MAX_INPUT_BYTES - 25)}</blockquote>`
    expect(Buffer.byteLength(quote)).toBe(STYLE_EXAMPLE_MAX_INPUT_BYTES)
    for (
      let index = 0;
      index < STYLE_EXAMPLES_MAX_TOTAL_INPUT_BYTES / STYLE_EXAMPLE_MAX_INPUT_BYTES;
      index++
    ) {
      addMessage(db, { id: `quote-${index}`, internalDate: index + 2, body: null, html: quote })
    }
    addMessage(db, { id: 'beyond-budget', internalDate: 1, body: 'Must not be read this time.' })
    const readSizes = trackBodyReads(db)
    expect(listStyleExamples(db, ACCOUNT, 'current-thread')).toEqual([])
    expect(Math.max(...readSizes)).toBeLessThanOrEqual(STYLE_EXAMPLE_MAX_INPUT_BYTES)
    expect(readSizes.reduce((sum, size) => sum + size, 0)).toBe(STYLE_EXAMPLES_MAX_TOTAL_INPUT_BYTES)
  })

  it('excludes header-only and oversized rows before applying the candidate count', () => {
    const db = store()
    addMessage(db, { id: 'usable', internalDate: 1, body: 'Older usable answer.' })
    const oversized = 'x'.repeat(STYLE_EXAMPLE_MAX_INPUT_BYTES + 1)
    for (let index = 0; index < 201; index++) {
      addMessage(db, { id: `header-${index}`, internalDate: index + 2, body: null })
      addMessage(db, { id: `oversized-${index}`, internalDate: index + 2, body: null, html: oversized })
    }
    const readSizes = trackBodyReads(db)
    expect(listStyleExamples(db, ACCOUNT, 'current-thread')).toEqual(['Older usable answer.'])
    expect(readSizes.reduce((sum, size) => sum + size, 0)).toBe(Buffer.byteLength('Older usable answer.'))
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
