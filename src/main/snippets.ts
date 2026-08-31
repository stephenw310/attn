import { randomUUID } from 'node:crypto'
import {
  normalizeSnippetTrigger,
  SNIPPET_BODY_MAX_LENGTH,
  SNIPPET_NAME_MAX_LENGTH,
  SNIPPET_SUBJECT_MAX_LENGTH,
  type Snippet,
  type SnippetSaveInput
} from '../shared/snippets'
import type { Db } from './db'
import { APP_SETTINGS_ACCOUNT_ID } from './settings'

// F8 snippets are app-global (F18 rule 9): every row is written under the app
// sentinel, so the set serves every signed-in account and survives sign-outs.
// The renderer sanitizes bodies through the composer path on save and again on
// insert; this module only enforces shape and the trigger's uniqueness.

interface SnippetRow {
  id: string
  name: string
  trigger: string | null
  subject: string | null
  body_html: string
  updated_at: number
}

export function listSnippets(db: Db): Snippet[] {
  const rows = db
    .prepare(
      `SELECT id, name, trigger, subject, body_html, updated_at FROM snippets
       WHERE account_id = ? ORDER BY name COLLATE NOCASE, id`
    )
    .all(APP_SETTINGS_ACCOUNT_ID) as SnippetRow[]
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    trigger: row.trigger,
    subject: row.subject,
    bodyHtml: row.body_html,
    updatedAt: row.updated_at
  }))
}

export function isSnippetSaveInput(value: unknown): value is SnippetSaveInput {
  if (typeof value !== 'object' || value === null) return false
  const input = value as Record<string, unknown>
  return (
    (input.id === null || typeof input.id === 'string') &&
    typeof input.name === 'string' &&
    (input.trigger === null || typeof input.trigger === 'string') &&
    (input.subject === null || typeof input.subject === 'string') &&
    typeof input.bodyHtml === 'string'
  )
}

export function saveSnippet(db: Db, input: SnippetSaveInput, now = Date.now()): Snippet[] {
  const name = input.name.trim()
  if (name === '' || name.length > SNIPPET_NAME_MAX_LENGTH) throw new Error('snippet name is required')
  const trigger = normalizeSnippetTrigger(input.trigger ?? '')
  if (trigger === undefined) throw new Error('invalid snippet trigger')
  const subject = input.subject?.trim() || null
  if (subject !== null && subject.length > SNIPPET_SUBJECT_MAX_LENGTH) {
    throw new Error('snippet subject is too long')
  }
  if (input.bodyHtml.length > SNIPPET_BODY_MAX_LENGTH) throw new Error('snippet body is too large')
  const id = input.id ?? randomUUID()
  if (input.id !== null) {
    const exists = db
      .prepare('SELECT 1 FROM snippets WHERE account_id = ? AND id = ?')
      .get(APP_SETTINGS_ACCOUNT_ID, input.id)
    if (!exists) throw new Error('snippet not found')
  }
  try {
    db.prepare(
      `INSERT INTO snippets (account_id, id, name, trigger, subject, body_html, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(account_id, id) DO UPDATE SET
         name = excluded.name, trigger = excluded.trigger, subject = excluded.subject,
         body_html = excluded.body_html, updated_at = excluded.updated_at`
    ).run(APP_SETTINGS_ACCOUNT_ID, id, name, trigger, subject, input.bodyHtml, now)
  } catch (error) {
    if (error instanceof Error && error.message.includes('snippets.trigger')) {
      throw new Error('another snippet already uses that trigger')
    }
    throw error
  }
  return listSnippets(db)
}

export function deleteSnippet(db: Db, id: string): Snippet[] {
  db.prepare('DELETE FROM snippets WHERE account_id = ? AND id = ?').run(APP_SETTINGS_ACCOUNT_ID, id)
  return listSnippets(db)
}
