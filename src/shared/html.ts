/**
 * Escape a string for use inside an HTML text node (review R8). Deliberately
 * the three text-node entities only: the composer and draft-mirror bodies it
 * feeds are fingerprinted byte-for-byte against Gmail round trips, so widening
 * to attribute-style quote escaping would change stored bytes for no safety
 * gain. Attribute contexts use the wider escaper in `src/main/outbox/text.ts`.
 */
export function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
