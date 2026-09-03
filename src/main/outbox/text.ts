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
