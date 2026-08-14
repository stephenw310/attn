import type { Config, DOMPurify } from 'dompurify'

export const MAIL_TRIM_MARKER = 'data-attn-trim-start'
export const MAIL_CID_SOURCE_MARKER = 'data-attn-cid-source'

const MAIL_SANITIZER_CONFIG: Config = {
  FORBID_TAGS: ['script', 'form', 'input', 'button', 'select', 'textarea'],
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

/** The single DOMPurify policy for cached mail, whether displayed or quoted. */
export function sanitizeMailHtml(purifier: DOMPurify, html: string): string {
  return purifier.sanitize(html, MAIL_SANITIZER_CONFIG)
}
