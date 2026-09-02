// Voice-matching style examples (T37, F17/F18): a handful of the user's own
// recent sent replies, selected locally from the owning account's store.
// Only explicit reply/refine requests may carry these — autocomplete never
// does — and the renderer includes them only when the voice-matching toggle
// is on (the transport strips them again when it is off).

import type { Db } from '../db'

export const STYLE_EXAMPLE_COUNT = 3
export const STYLE_EXAMPLE_MAX_CHARS = 2_000
const CANDIDATE_SCAN_LIMIT = 200

interface CandidateRow {
  body_text: string
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
 * (so standalone announcements do not shape the voice) and a non-empty body.
 * Label filtering happens in JS — a LIKE over labels_json would also match
 * substrings — over a bounded newest-first candidate scan.
 */
export function listStyleExamples(db: Db, accountId: string): string[] {
  const rows = db
    .prepare(
      `SELECT body_text, labels_json FROM messages
       WHERE account_id = ? AND references_json IS NOT NULL
         AND body_text IS NOT NULL AND TRIM(body_text) != ''
       ORDER BY internal_date DESC
       LIMIT ${CANDIDATE_SCAN_LIMIT}`
    )
    .all(accountId) as CandidateRow[]
  const examples: string[] = []
  for (const row of rows) {
    const labels = labelsOf(row)
    if (!labels.includes('SENT') || labels.includes('DRAFT')) continue
    examples.push(row.body_text.trim().slice(0, STYLE_EXAMPLE_MAX_CHARS))
    if (examples.length === STYLE_EXAMPLE_COUNT) break
  }
  return examples
}
