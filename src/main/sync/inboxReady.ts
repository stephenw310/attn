import { BACKFILL_PHASES, parseBackfillCursor } from './backfillCursor'

const FIRST_READY_PHASE = BACKFILL_PHASES.indexOf('drafts')

/**
 * Inbox split membership is authoritative after the full-body Inbox walk and
 * any one-time split metadata rebuild have both finished.
 */
export function inboxBackfillReady(
  backfillCursor: string | null | undefined,
  splitMetadataCursor: string | null | undefined
): boolean {
  if (!backfillCursor || splitMetadataCursor !== 'done') return false
  if (backfillCursor === 'done') return true
  const { phase } = parseBackfillCursor(backfillCursor)
  return BACKFILL_PHASES.indexOf(phase) >= FIRST_READY_PHASE
}
