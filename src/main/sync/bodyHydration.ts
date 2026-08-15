export interface StoredMessageBody {
  bodyText: string | null | undefined
  bodyHtml: string | null | undefined
}

/** Metadata-only rows have neither a stored plain-text body nor stored HTML. */
export function needsBodyHydration(body: StoredMessageBody): boolean {
  return !body.bodyText?.trim() && !body.bodyHtml?.trim()
}
