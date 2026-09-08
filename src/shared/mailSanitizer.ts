import type { Config, DOMPurify } from 'dompurify'
import { cssDeclarations } from './css'

export const MAIL_TRIM_MARKER = 'data-attn-trim-start'
export const MAIL_CID_SOURCE_MARKER = 'data-attn-cid-source'
export const MAIL_IMAGE_PENDING_MARKER = 'data-attn-image-pending'

const FORBIDDEN_MAIL_TAGS = ['script', 'form', 'input', 'button', 'select', 'textarea']
// A quote is embedded into a document the recipient renders, so two tags that are
// harmless on display stop being harmless: `style` is document-scoped there and
// could hide or restyle the text the user wrote, and `title` is head metadata that
// renders as nothing but rides along in outgoing mail. Display keeps both — its
// iframe confines sender CSS, and a title never surfaces in the reader.
const FORBIDDEN_QUOTE_TAGS = [...FORBIDDEN_MAIL_TAGS, 'style', 'title']

const BASE_MAIL_SANITIZER_CONFIG: Config = {
  // DOMPurify passes data-* through by default. Mail cannot claim Attn's private
  // markers or move the renderer's trim and inline-image boundaries. Event
  // handlers need no entry here: DOMPurify's allowlist admits no `on*`
  // attribute, and `mailSanitizer.test.ts` pins that.
  FORBID_ATTR: [MAIL_TRIM_MARKER, MAIL_CID_SOURCE_MARKER, MAIL_IMAGE_PENDING_MARKER],
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
const FLOW_ESCAPING_PROPERTY =
  /^(position|z-index|inset|top|right|bottom|left|transform|translate|rotate|scale|offset|text-indent)(-|$)/
// `behavior` and `-moz-binding` ran script from CSS in IE and pre-2013 Gecko, as
// did `expression()`. No mail client in service still honours them; they are
// dropped because a sanitizer that emits them invites the question, not because
// any recipient is at risk.
const LEGACY_SCRIPTING_PROPERTY = /^(behavior|binding)$/
const LEGACY_SCRIPTING_VALUE = /expression\s*\(/i
// Custom properties make value-based checks unreliable. A declaration such as
// `margin:var(--m)` can resolve to a negative length defined elsewhere in the
// quote, so quoted mail does not retain declarations that consume them.
const CUSTOM_PROPERTY_REFERENCE = /var\s*\(/i
const VENDOR_PREFIX = /^-(?:webkit|moz|ms|o)-/
// Browsers decode escapes before interpreting CSS identifiers, while this
// filter reads the original attribute text. Drop an escaped declaration rather
// than maintain a second, security-sensitive CSS tokenizer here.
const CSS_ESCAPE = /\\/
// A negative margin drags quoted content up over the reply without needing
// `position`, so it is the one case where the value decides, not the name. The
// minus can follow a `calc()` operator as well as a separator — `calc(600px*-1)`
// and `calc(1px/-0.01)` are both negative lengths.
const NEGATIVE_LENGTH = /(?:^|[\s,(*/])-\s*\.?\d/

function isUnsafeDeclaration(property: string, value: string): boolean {
  if (CSS_ESCAPE.test(property) || CSS_ESCAPE.test(value)) return true
  const name = property.replace(VENDOR_PREFIX, '')
  if (FLOW_ESCAPING_PROPERTY.test(name) || LEGACY_SCRIPTING_PROPERTY.test(name)) return true
  if (LEGACY_SCRIPTING_VALUE.test(value) || CUSTOM_PROPERTY_REFERENCE.test(value)) return true
  return name.startsWith('margin') && NEGATIVE_LENGTH.test(value)
}

/** Drop the inline declarations that would let quoted mail cover authored text. */
export function stripUnsafeQuoteCss(style: string): string {
  return cssDeclarations(style)
    .filter(({ property, value }) => !isUnsafeDeclaration(property, value))
    .map(({ raw }) => raw)
    .join('; ')
}

/**
 * Drop every `@font-face` a sender wrote.
 *
 * The mail frame needs `font-src` open enough to load Attn's own faces, so the
 * policy alone cannot tell our typeface from theirs. This is the half that can:
 * the rule never reaches the frame, and the policy stays as the backstop. The
 * name is read through CSS escapes, because `@\66 ont-face` is the same at-rule
 * to a parser and a plain string match would walk past it.
 */
export function stripFontFaceRules(css: string): string {
  let output = ''
  let cursor = 0
  while (cursor < css.length) {
    const at = css.indexOf('@', cursor)
    if (at === -1) return output + css.slice(cursor)
    output += css.slice(cursor, at)
    let scan = at + 1
    let name = ''
    while (scan < css.length && !/[\s{;]/.test(css[scan])) {
      if (css[scan] !== '\\') {
        name += css[scan]
        scan += 1
        continue
      }
      const escaped = /^\\([0-9a-fA-F]{1,6})[ \t\n]?/.exec(css.slice(scan))
      if (escaped) {
        name += String.fromCodePoint(Number.parseInt(escaped[1], 16))
        scan += escaped[0].length
        continue
      }
      name += css[scan + 1] ?? ''
      scan += 2
    }
    if (name.toLowerCase() !== 'font-face') {
      output += '@'
      cursor = at + 1
      continue
    }
    const open = css.indexOf('{', scan)
    if (open === -1) return output
    let depth = 0
    let close = open
    for (; close < css.length; close += 1) {
      if (css[close] === '{') depth += 1
      else if (css[close] === '}') {
        depth -= 1
        if (depth === 0) {
          close += 1
          break
        }
      }
    }
    cursor = close
  }
  return output
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

const displayHooked = new WeakSet<DOMPurify>()
let displaying = false

// A mail link opens in the user's browser, never inside the frame, so display
// forces `target`/`rel` onto every anchor. It lives here rather than at one
// caller's module scope because the policy, not the import order of whichever
// renderer module happened to evaluate first, has to decide it. The flag keeps
// the hook inert if a quote purifier is ever passed in here.
function installDisplayLinkHook(purifier: DOMPurify): void {
  if (displayHooked.has(purifier)) return
  displayHooked.add(purifier)
  purifier.addHook('afterSanitizeAttributes', (node) => {
    if (!displaying || node.nodeName !== 'A') return
    const link = node as Element
    if (typeof link.setAttribute !== 'function') return
    link.setAttribute('target', '_blank')
    link.setAttribute('rel', 'noopener noreferrer')
  })
  purifier.addHook('afterSanitizeElements', (node) => {
    if (!displaying || node.nodeName !== 'STYLE') return
    const style = node as Element
    const css = style.textContent ?? ''
    if (!css.includes('@')) return
    style.textContent = stripFontFaceRules(css)
  })
}

/** The shared DOMPurify display policy for cached mail. */
export function sanitizeMailHtml(purifier: DOMPurify, html: string): string {
  installDisplayLinkHook(purifier)
  displaying = true
  try {
    return purifier.sanitize(html, MAIL_SANITIZER_CONFIG)
  } finally {
    displaying = false
  }
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
