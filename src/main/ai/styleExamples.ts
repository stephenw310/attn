// Voice-matching style examples (T37, F17/F18): a handful of the user's own
// recent sent replies, selected locally from the owning account's store.
// Only explicit reply/refine requests may carry these — autocomplete never
// does — and the renderer includes them only when the voice-matching toggle
// is on (the transport strips them again when it is off).

import type { Db } from '../db'
import { styleExampleText } from './styleText'

export const STYLE_EXAMPLE_COUNT = 3
export const STYLE_EXAMPLE_MAX_CHARS = 2_000
const CANDIDATE_SCAN_LIMIT = 200

interface CandidateRow {
  body_text: string | null
  body_html: string | null
  labels_json: string | null
}

function labelsOf(row: CandidateRow): string[] {
  if (row.labels_json === null) return []
  try {
    return JSON.parse(row.labels_json) as string[]
  } catch {
    return []
  }
}

/**
 * The newest-first sent replies: SENT, not a draft, with a References chain
 * (so standalone announcements do not shape the voice) and non-empty authored text.
 * Label filtering happens in JS — a LIKE over labels_json would also match
 * substrings — over a bounded newest-first candidate scan. Exclude the
 * conversation being answered so later replies and their quoted history
 * cannot bypass the reply context cutoff.
 */
export function listStyleExamples(db: Db, accountId: string, excludeThreadId: string): string[] {
  const rows = db
    .prepare(
      `SELECT body_text, body_html, labels_json FROM messages
       WHERE account_id = ? AND thread_id != ? AND references_json IS NOT NULL
         AND (NULLIF(TRIM(body_text), '') IS NOT NULL OR NULLIF(TRIM(body_html), '') IS NOT NULL)
       ORDER BY internal_date DESC
       LIMIT ${CANDIDATE_SCAN_LIMIT}`
    )
    .all(accountId, excludeThreadId) as CandidateRow[]
  const examples: string[] = []
  for (const row of rows) {
    const labels = labelsOf(row)
    if (!labels.includes('SENT') || labels.includes('DRAFT')) continue
    const text = styleExampleText(row.body_text, row.body_html)
    if (!text) continue
    examples.push(text.slice(0, STYLE_EXAMPLE_MAX_CHARS))
    if (examples.length === STYLE_EXAMPLE_COUNT) break
  }
  return examples
}
