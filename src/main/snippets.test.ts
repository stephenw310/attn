import { describe, expect, it } from 'vitest'
import { openDatabase } from './db'
import { purgeAccountRows } from './db/purgeAccount'
import { deleteSnippet, isSnippetSaveInput, listSnippets, saveSnippet } from './snippets'

const input = { id: null, name: 'Intro', trigger: 'intro', subject: null, bodyHtml: '<div>Hi</div>' }

describe('snippet storage', () => {
  it('creates, lists by name, and returns the fresh list from every mutation', () => {
    const db = openDatabase(':memory:')
    saveSnippet(db, { ...input, name: 'Zeta', trigger: 'z' }, 1)
    const list = saveSnippet(db, { ...input, name: 'alpha', trigger: 'a' }, 2)
    expect(list.map((snippet) => snippet.name)).toEqual(['alpha', 'Zeta'])
    expect(list[0]).toMatchObject({ trigger: 'a', subject: null, bodyHtml: '<div>Hi</div>', updatedAt: 2 })
  })

  it('updates in place by id and rejects an unknown id', () => {
    const db = openDatabase(':memory:')
    const [saved] = saveSnippet(db, input, 1)
    const updated = saveSnippet(db, { ...input, id: saved.id, name: 'Renamed', trigger: null }, 2)
    expect(updated).toHaveLength(1)
    expect(updated[0]).toMatchObject({ id: saved.id, name: 'Renamed', trigger: null, updatedAt: 2 })
    expect(() => saveSnippet(db, { ...input, id: 'missing' })).toThrow('snippet not found')
  })

  it('normalizes the trigger and enforces its uniqueness', () => {
    const db = openDatabase(':memory:')
    const [saved] = saveSnippet(db, { ...input, trigger: ' ;Intro ' })
    expect(saved.trigger).toBe('intro')
    expect(() => saveSnippet(db, { ...input, name: 'Other' })).toThrow(
      'another snippet already uses that trigger'
    )
    // Triggerless snippets never collide: the partial index skips NULLs.
    saveSnippet(db, { ...input, name: 'One', trigger: null })
    saveSnippet(db, { ...input, name: 'Two', trigger: null })
    expect(listSnippets(db)).toHaveLength(3)
  })

  it('rejects invalid shapes before touching the store', () => {
    const db = openDatabase(':memory:')
    expect(() => saveSnippet(db, { ...input, name: '   ' })).toThrow('snippet name is required')
    expect(() => saveSnippet(db, { ...input, trigger: 'two words' })).toThrow('invalid snippet trigger')
    expect(listSnippets(db)).toEqual([])
  })

  it('deletes by id', () => {
    const db = openDatabase(':memory:')
    const [saved] = saveSnippet(db, input)
    expect(deleteSnippet(db, saved.id)).toEqual([])
    expect(deleteSnippet(db, 'missing')).toEqual([])
  })

  it('is app-global: removing an account leaves the snippet set intact (F18 rule 9)', () => {
    const db = openDatabase(':memory:')
    db.prepare('INSERT INTO accounts (id, email, created_at) VALUES (?, ?, 0)').run(
      'user@attn.test',
      'user@attn.test'
    )
    saveSnippet(db, input)
    const result = purgeAccountRows(db, 'user@attn.test')
    expect(result.tables).toContain('snippets')
    expect(listSnippets(db)).toHaveLength(1)
  })
})

describe('isSnippetSaveInput', () => {
  it('accepts the wire shape and rejects near-misses', () => {
    expect(isSnippetSaveInput(input)).toBe(true)
    expect(isSnippetSaveInput({ ...input, id: 'abc' })).toBe(true)
    expect(isSnippetSaveInput(null)).toBe(false)
    expect(isSnippetSaveInput({ ...input, name: 7 })).toBe(false)
    expect(isSnippetSaveInput({ ...input, bodyHtml: undefined })).toBe(false)
  })
})
