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

// Forbidding the style *element* is only half the job: an inline
// `position:fixed;inset:0;background:#fff` on a quoted element escapes the
// blockquote just as effectively and lands on top of the reply the user wrote.
// Strip only the properties that let content leave normal flow — colour, font,
// border, background, padding and table layout stay, because a quote stripped of
// its formatting is a worse quote.
const FLOW_ESCAPING_PROPERTY = /^(position|z-index|inset|top|right|bottom|left|transform)(-|$)/
// `behavior` and `-moz-binding` ran script from CSS in IE and pre-2013 Gecko, as
// did `expression()`. No mail client in service still honours them; they are
// dropped because a sanitizer that emits them invites the question, not because
// any recipient is at risk.
const LEGACY_SCRIPTING_PROPERTY = /^(behavior|binding)$/
const LEGACY_SCRIPTING_VALUE = /expression\s*\(/i
const VENDOR_PREFIX = /^-(?:webkit|moz|ms|o)-/
// A negative margin drags quoted content up over the reply without needing
// `position`, so it is the one case where the value decides, not the name.
const NEGATIVE_LENGTH = /(?:^|[\s,(])-\s*\.?\d/

function isUnsafeDeclaration(property: string, value: string): boolean {
  const name = property.replace(VENDOR_PREFIX, '')
  if (FLOW_ESCAPING_PROPERTY.test(name) || LEGACY_SCRIPTING_PROPERTY.test(name)) return true
  if (LEGACY_SCRIPTING_VALUE.test(value)) return true
  return name.startsWith('margin') && NEGATIVE_LENGTH.test(value)
}

/**
 * Split on top-level `;` only. jsdom's CSSOM cannot be used here: it silently
 * parses zero declarations out of values it does not fully support (`inset`,
 * `url(data:...;base64,…)`), which would hand the attacker exactly the payload
 * this filter exists to remove.
 */
function splitCssDeclarations(style: string): string[] {
  const declarations: string[] = []
  let current = ''
  let depth = 0
  let quote: string | null = null
  let escaped = false

  for (const character of style) {
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (character === '\\') {
      current += character
      escaped = true
      continue
    }
    if (quote) {
      current += character
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '(') depth += 1
    else if (character === ')') depth = Math.max(0, depth - 1)
    else if (character === ';' && depth === 0) {
      declarations.push(current)
      current = ''
      continue
    }
    current += character
  }
  declarations.push(current)
  return declarations
}

/** Drop the inline declarations that would let quoted mail cover authored text. */
export function stripUnsafeQuoteCss(style: string): string {
  return splitCssDeclarations(style)
    .filter((declaration) => {
      const separator = declaration.indexOf(':')
      if (separator < 0) return false
      const property = declaration.slice(0, separator).trim().toLowerCase()
      return property !== '' && !isUnsafeDeclaration(property, declaration.slice(separator + 1))
    })
    .map((declaration) => declaration.trim())
    .join('; ')
}

const quoteHooked = new WeakSet<DOMPurify>()
let quoting = false

// Installed on the purifier rather than left to callers: the style filter is part
// of the quote policy, and a caller that forgot it would silently ship the hole.
// The flag keeps the hook inert if a display purifier is ever passed in here.
function installQuoteStyleHook(purifier: DOMPurify): void {
  if (quoteHooked.has(purifier)) return
  quoteHooked.add(purifier)
  purifier.addHook('afterSanitizeAttributes', (node) => {
    if (!quoting) return
    const element = node as Element
    if (typeof element.getAttribute !== 'function') return
    const style = element.getAttribute('style')
    if (!style) return
    const filtered = stripUnsafeQuoteCss(style)
    if (filtered) element.setAttribute('style', filtered)
    else element.removeAttribute('style')
  })
}

/** The shared DOMPurify display policy for cached mail. */
export function sanitizeMailHtml(purifier: DOMPurify, html: string): string {
  return purifier.sanitize(html, MAIL_SANITIZER_CONFIG)
}

/** The display policy tightened for HTML embedded into an outgoing quote. */
export function sanitizeQuotedMailHtml(purifier: DOMPurify, html: string): string {
  installQuoteStyleHook(purifier)
  quoting = true
  try {
    return purifier.sanitize(html, QUOTED_MAIL_SANITIZER_CONFIG)
  } finally {
    quoting = false
  }
}
