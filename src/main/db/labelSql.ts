// One encoding of "this message carries a label". Gmail labels are message-level
// (S2), but rows written before the store kept `labels_json` only have the
// thread-level union, so every predicate needs the same legacy fallback. Three
// hand-written copies of that rule had already drifted in alias handling.

export interface MessageLabelSqlOptions {
  /** Alias of the `messages` row under test. */
  message: string
  /** SQL naming the label: a quoted literal, a column reference, or a `?` bind. */
  label: string
  /**
   * Where the legacy fallback finds the thread. Defaults to the message row's
   * own keys; a query that already joined `threads` can point at that alias so
   * SQLite keeps its existing access path.
   */
  thread?: { accountId: string; id: string }
}

/** The authoritative case: `labels_json` holds the label. */
export function storedMessageLabelSql(message: string, label: string): string {
  return `EXISTS (SELECT 1 FROM json_each(${message}.labels_json) WHERE value = ${label})`
}

/** The legacy case: no stored message labels, so the thread-level union answers. */
export function threadLabelSql(thread: { accountId: string; id: string }, label: string): string {
  return `EXISTS (SELECT 1 FROM thread_labels label_row
            WHERE label_row.account_id = ${thread.accountId} AND label_row.thread_id = ${thread.id}
              AND label_row.label_id = ${label})`
}

/** "The message carries the label", with the legacy thread-level fallback. */
export function messageHasLabelSql(options: MessageLabelSqlOptions): string {
  const { message, label } = options
  const thread = options.thread ?? { accountId: `${message}.account_id`, id: `${message}.thread_id` }
  return `((${message}.labels_json IS NOT NULL AND ${storedMessageLabelSql(message, label)})
    OR (${message}.labels_json IS NULL AND ${threadLabelSql(thread, label)}))`
}

/** "The message carries none of these labels", with the same legacy fallback. */
export function messageHasNoLabelSql(options: {
  message: string
  labels: readonly string[]
  thread?: { accountId: string; id: string }
}): string {
  const { message } = options
  const thread = options.thread ?? { accountId: `${message}.account_id`, id: `${message}.thread_id` }
  const list = options.labels.map((label) => `'${label}'`).join(', ')
  return `((${message}.labels_json IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM json_each(${message}.labels_json) WHERE value IN (${list})
    )) OR (${message}.labels_json IS NULL AND NOT EXISTS (
      SELECT 1 FROM thread_labels label_row
      WHERE label_row.account_id = ${thread.accountId} AND label_row.thread_id = ${thread.id}
        AND label_row.label_id IN (${list})
    )))`
}
