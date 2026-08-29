/**
 * Inbox metadata is authoritative once the metadata walk checkpoints the next
 * stage. A missing or paged metadata cursor still describes a partial Inbox.
 */
export function inboxBackfillReady(cursor: string | null | undefined): boolean {
  if (!cursor) return false
  return (
    /^(?:bodies|drafts|all-mail|spam|trash|sent)(?::.+)?$/.test(cursor) ||
    cursor === 'reconcile' ||
    cursor === 'done'
  )
}
