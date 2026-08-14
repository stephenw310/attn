import type { Config, DOMPurify } from 'dompurify'

export const MAIL_TRIM_MARKER = 'data-attn-trim-start'
export const MAIL_CID_SOURCE_MARKER = 'data-attn-cid-source'

const FORBIDDEN_MAIL_TAGS = ['script', 'form', 'input', 'button', 'select', 'textarea']

const MAIL_SANITIZER_CONFIG: Config = {
  FORBID_TAGS: FORBIDDEN_MAIL_TAGS,
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
  ADD_TAGS: ['style'],
  ADD_ATTR: ['target'],
  FORCE_BODY: true
}

const QUOTED_MAIL_SANITIZER_CONFIG: Config = {
  ...MAIL_SANITIZER_CONFIG,
  // Display confines sender CSS to a scriptless iframe. A quote becomes part of
  // a new document, where a style element could hide or restyle authored text.
  FORBID_TAGS: [...FORBIDDEN_MAIL_TAGS, 'style']
}

/** The shared DOMPurify display policy for cached mail. */
export function sanitizeMailHtml(purifier: DOMPurify, html: string): string {
  return purifier.sanitize(html, MAIL_SANITIZER_CONFIG)
}

/** The display policy tightened for HTML embedded into an outgoing quote. */
export function sanitizeQuotedMailHtml(purifier: DOMPurify, html: string): string {
  return purifier.sanitize(html, QUOTED_MAIL_SANITIZER_CONFIG)
}
