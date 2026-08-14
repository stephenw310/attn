import type { Config, DOMPurify } from 'dompurify'

export const MAIL_TRIM_MARKER = 'data-attn-trim-start'
export const MAIL_CID_SOURCE_MARKER = 'data-attn-cid-source'

const FORBIDDEN_MAIL_TAGS = ['script', 'form', 'input', 'button', 'select', 'textarea']
// A quote is embedded into a document the recipient renders, so two tags that are
// harmless on display stop being harmless: `style` is document-scoped there and
// could hide or restyle the text the user wrote, and `title` is head metadata that
// renders as nothing but rides along in outgoing mail. Display keeps both — its
// iframe confines sender CSS, and a title never surfaces in the reader.
const FORBIDDEN_QUOTE_TAGS = [...FORBIDDEN_MAIL_TAGS, 'style', 'title']

const BASE_MAIL_SANITIZER_CONFIG: Config = {
  // DOMPurify passes data-* through by default. Mail cannot claim Attn's private
  // markers or move the renderer's trim and inline-image boundaries.
  FORBID_ATTR: [
    'onerror',
    'onload',
    'onclick',
    'onmouseover',
    'onfocus',
    MAIL_TRIM_MARKER,
    MAIL_CID_SOURCE_MARKER
  ],
  ADD_ATTR: ['target'],
  FORCE_BODY: true
}

// `style` is not in DOMPurify's default allowlist, so display opts into it here
// and the quote policy simply never does — neither config both adds and forbids it.
const MAIL_SANITIZER_CONFIG: Config = {
  ...BASE_MAIL_SANITIZER_CONFIG,
  FORBID_TAGS: FORBIDDEN_MAIL_TAGS,
  ADD_TAGS: ['style']
}

const QUOTED_MAIL_SANITIZER_CONFIG: Config = {
  ...BASE_MAIL_SANITIZER_CONFIG,
  FORBID_TAGS: FORBIDDEN_QUOTE_TAGS
}

/** The shared DOMPurify display policy for cached mail. */
export function sanitizeMailHtml(purifier: DOMPurify, html: string): string {
  return purifier.sanitize(html, MAIL_SANITIZER_CONFIG)
}

/** The display policy tightened for HTML embedded into an outgoing quote. */
export function sanitizeQuotedMailHtml(purifier: DOMPurify, html: string): string {
  return purifier.sanitize(html, QUOTED_MAIL_SANITIZER_CONFIG)
}
