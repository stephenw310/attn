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
 * Drop every `@font-face` a sender wrote, using the engine's own parser.
 *
 * The mail frame needs `font-src` open enough to load Attn's own faces, so the
 * policy alone cannot tell our typeface from theirs. This is the half that can.
 * It reads the sheet with `CSSStyleSheet`, because the only guard that agrees
 * with the browser on what an at-rule is, is the browser: a hand-written scan
 * lost to `@font-face/**\/{}`, to a form feed after an escape, and to a brace
 * inside a `url()` that a tokenizer never sees as a brace at all.
 *
 * A sheet with no font-face keeps its exact text — reserializing would quietly
 * drop the hacks and unknown at-rules ordinary mail leans on. Only a sheet that
 * carried one is written back.
 */
export function dropSenderFontFaces(style: Element): void {
  const css = style.textContent ?? ''
  if (!css.includes('@')) return
  // The ambient constructor, not `ownerDocument.defaultView`: DOMPurify parses
  // into a document from `createHTMLDocument`, whose `defaultView` is null, and
  // reading it there sent every sheet down the fail-closed path below — which
  // blocked the fonts and took ordinary `@media` mail with them.
  const Sheet = typeof CSSStyleSheet === 'undefined' ? null : CSSStyleSheet
  if (!Sheet || typeof Sheet.prototype.replaceSync !== 'function') {
    // Nothing here can agree with a parser that is not present, so drop the
    // sheet rather than guess at its text. Display runs in the renderer, where
    // the parser is always there, so this is unreached in practice — it is the
    // shape of the failure, not a path with a test behind it.
    style.remove()
    return
  }
  let sheet: CSSStyleSheet
  try {
    sheet = new Sheet()
    sheet.replaceSync(css)
  } catch {
    style.remove()
    return
  }
  if (!removeFontFaceRules(sheet)) return
  style.textContent = [...sheet.cssRules].map((rule) => rule.cssText).join('\n')
}

/** Delete every font-face rule, at any depth, and say whether one was there. */
function removeFontFaceRules(parent: CSSStyleSheet | CSSGroupingRule): boolean {
  let found = false
  for (let index = parent.cssRules.length - 1; index >= 0; index -= 1) {
    const rule = parent.cssRules[index]
    // `CSSFontFaceRule` is not defined in every environment, and a rule inside
    // `@media` or `@supports` has to be reached through its group.
    if (rule.constructor?.name === 'CSSFontFaceRule' || rule.type === 5) {
      parent.deleteRule(index)
      found = true
      continue
    }
    if ('cssRules' in rule && removeFontFaceRules(rule as CSSGroupingRule)) found = true
  }
  return found
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
    // `localName`, not `nodeName`: a `<style>` inside inline SVG is in the SVG
    // namespace, where `nodeName` is lowercase — and it still styles the whole
    // document, `@font-face` included.
    if (!displaying || (node as Element).localName !== 'style') return
    dropSenderFontFaces(node as Element)
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
