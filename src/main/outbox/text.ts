/** Collapse a value to one header-safe line: no CR, LF or NUL can survive. */
export function singleLine(value: string): string {
  return value.replace(/[\r\n\0]+/g, ' ').trim()
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * Authored body plus its quoted reply, joined only when both exist — one rule
 * for the sent MIME and for reading an outbox row back into a conversation.
 */
export function combinedBody(primary: string, quote: string | null | undefined, separator: string): string {
  if (!quote) return primary
  if (!primary) return quote
  return `${primary}${separator}${quote}`
}
