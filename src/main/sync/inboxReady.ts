/**
 * Inbox split membership is authoritative after the full-body Inbox walk and
 * any one-time split metadata rebuild have both finished.
 */
export function inboxBackfillReady(
  backfillCursor: string | null | undefined,
  splitMetadataCursor: string | null | undefined
): boolean {
  if (!backfillCursor || splitMetadataCursor !== 'done') return false
  return (
    /^(?:drafts|all-mail|spam|trash|sent)(?::.+)?$/.test(backfillCursor) ||
    backfillCursor === 'reconcile' ||
    backfillCursor === 'done'
  )
}
