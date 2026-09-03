// F8 snippets: named reusable text blocks, app-global (F18 rule 9). The rows
// live in the utility's SQLite store under the app sentinel account id.

export interface Snippet {
  id: string
  name: string
  /** Inline expansion word: typing `;trigger ` in the composer inserts the body. */
  trigger: string | null
  /** Fills the composer subject only when the subject is empty. */
  subject: string | null
  bodyHtml: string
  updatedAt: number
}

export interface SnippetSaveInput {
  /** null creates; an existing id updates in place. */
  id: string | null
  name: string
  trigger: string | null
  subject: string | null
  bodyHtml: string
}

/** Marker inside a snippet body naming where the caret lands after insertion. */
export const SNIPPET_CURSOR_MARKER = '{cursor}'

export const SNIPPET_NAME_MAX_LENGTH = 100
export const SNIPPET_SUBJECT_MAX_LENGTH = 500
export const SNIPPET_BODY_MAX_LENGTH = 262_144
const SNIPPET_TRIGGER_MAX_LENGTH = 32

/** A trigger is one `;`-invokable word: letters/digits with - or _ inside. */
const TRIGGER_SHAPE = /^[a-z0-9][a-z0-9_-]*$/

/**
 * Canonicalize a user-typed trigger: trim, drop the optional leading `;`,
 * lowercase. Returns null for an empty field and undefined for input that can
 * never fire as an inline trigger, so callers reject rather than store it.
 */
export function normalizeSnippetTrigger(raw: string): string | null | undefined {
  const bare = raw.trim().replace(/^;/, '').toLowerCase()
  if (bare === '') return null
  if (bare.length > SNIPPET_TRIGGER_MAX_LENGTH || !TRIGGER_SHAPE.test(bare)) return undefined
  return bare
}

/** A snippet subject fills an empty composer subject and never overwrites (F8). */
export function subjectAfterSnippetInsert(current: string, snippetSubject: string | null): string {
  if (snippetSubject === null || snippetSubject === '' || current.trim() !== '') return current
  return snippetSubject
}

export interface InlineTriggerMatch {
  /** The canonical (lowercased) trigger word, without the `;`. */
  trigger: string
  /** Index of the `;` in the text the match was run against. */
  start: number
}

/**
 * Match the `;word` that ends exactly at the caret. Deliberate, not eager
 * (T34): the caller invokes this only on the space or Enter keystroke, and a
 * `;` inside a word never fires — the `;` must start the text or follow
 * whitespace.
 */
export function matchInlineSnippetTrigger(textBeforeCaret: string): InlineTriggerMatch | null {
  const match = /(?:^|[\s\u00a0]);([a-z0-9][a-z0-9_-]*)$/i.exec(textBeforeCaret)
  if (!match || match[1].length > SNIPPET_TRIGGER_MAX_LENGTH) return null
  return {
    trigger: match[1].toLowerCase(),
    start: textBeforeCaret.length - match[1].length - 1
  }
}
