// Voice-matching style examples (T37, F17/F18): a handful of the user's own
// recent sent replies, selected locally from the owning account's store.
// Only explicit reply/refine requests may carry these — autocomplete never
// does — and the renderer includes them only when the voice-matching toggle
// is on (the transport strips them again when it is off).

import type { Db } from '../db'
import { STYLE_EXAMPLE_MAX_INPUT_BYTES, styleExampleText } from './styleText'

export const STYLE_EXAMPLE_COUNT = 3
export const STYLE_EXAMPLE_MAX_CHARS = 2_000
export const STYLE_EXAMPLES_MAX_TOTAL_INPUT_BYTES = 256 * 1024
const CANDIDATE_SCAN_LIMIT = 200

interface CandidateRow {
  id: string
  input_bytes: number
  labels_json: string | null
}

interface CandidateBody {
  body_text: string | null
  body_html: string | null
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
      // octet_length reads column metadata without loading the body. Sorting
      // the newest 200 candidates must never materialize their body values.
      `SELECT id, labels_json,
              COALESCE(octet_length(body_text), 0) + COALESCE(octet_length(body_html), 0) AS input_bytes
       FROM messages
       WHERE account_id = ? AND thread_id != ? AND references_json IS NOT NULL
         AND COALESCE(octet_length(body_text), 0) + COALESCE(octet_length(body_html), 0)
             BETWEEN 1 AND ${STYLE_EXAMPLE_MAX_INPUT_BYTES}
       ORDER BY internal_date DESC
       LIMIT ${CANDIDATE_SCAN_LIMIT}`
    )
    .all(accountId, excludeThreadId) as CandidateRow[]
  const readBody = db.prepare(
    `SELECT body_text, body_html FROM messages
     WHERE account_id = ? AND id = ?
       AND COALESCE(octet_length(body_text), 0) + COALESCE(octet_length(body_html), 0)
           <= ${STYLE_EXAMPLE_MAX_INPUT_BYTES}`
  )
  const examples: string[] = []
  let remainingBytes = STYLE_EXAMPLES_MAX_TOTAL_INPUT_BYTES
  for (const row of rows) {
    const labels = labelsOf(row)
    if (!labels.includes('SENT') || labels.includes('DRAFT')) continue
    if (row.input_bytes === 0 || row.input_bytes > Math.min(STYLE_EXAMPLE_MAX_INPUT_BYTES, remainingBytes)) {
      continue
    }
    const body = readBody.get(accountId, row.id) as CandidateBody | undefined
    if (!body) continue
    remainingBytes -= row.input_bytes
    const text = styleExampleText(body.body_text, body.body_html)
    if (!text) continue
    examples.push(text.slice(0, STYLE_EXAMPLE_MAX_CHARS))
    if (examples.length === STYLE_EXAMPLE_COUNT) break
  }
  return examples
}
