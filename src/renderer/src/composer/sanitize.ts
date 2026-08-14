import createDOMPurify, { type DOMPurify } from 'dompurify'

const ALLOWED_TAGS = ['p', 'div', 'br', 'b', 'strong', 'i', 'em', 'u', 'a', 'ul', 'ol', 'li', 'blockquote']

// Keep outgoing mail isolated from MessageBody's singleton: that sanitizer has
// an inbound-mail hook which adds browser-only target/rel attributes to links.
let outgoingPurifier: DOMPurify | null = null

export function sanitizeOutgoingHtml(html: string): string {
  outgoingPurifier ??= createDOMPurify(window)
  return outgoingPurifier.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: ['href'],
    ALLOW_ARIA_ATTR: false,
    ALLOW_DATA_ATTR: false,
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i
  })
}
