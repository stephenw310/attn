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

/**
 * The one URL-scheme gate (review R8). Five callers used to spell this out
 * separately — two as a `^https?:|mailto:` prefix test, three through `URL` —
 * and they disagreed: a prefix test reads the raw text, while Chromium's
 * parser ignores ASCII whitespace inside a scheme, so `ht\ntp:` is `http:` to
 * the browser and something else entirely to a regular expression. Every
 * caller now names its own scheme set and gets the parser's answer.
 *
 * Returns the trimmed input, not the resolved URL: callers keep the author's
 * own href. `base` opts into resolving a relative value; without one a
 * relative value has no scheme and is refused.
 */
export function safeUrl(value: string, allowedSchemes: readonly string[], base?: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  try {
    const scheme = new URL(trimmed, base).protocol.slice(0, -1).toLowerCase()
    return allowedSchemes.includes(scheme) ? trimmed : null
  } catch {
    return null
  }
}
