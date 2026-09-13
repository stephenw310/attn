import createDOMPurify, { type DOMPurify } from 'dompurify'
import { cssDeclarations } from '../../../shared/css'

const ALLOWED_TAGS = [
  'p',
  'div',
  'br',
  'b',
  'strong',
  'i',
  'em',
  'u',
  's',
  'strike',
  'a',
  'ul',
  'ol',
  'li',
  'blockquote',
  'span',
  'font',
  'img',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td'
]

export const COMPOSER_STYLE_PROPERTIES = new Set([
  'background',
  'background-color',
  'border',
  'border-bottom',
  'border-collapse',
  'border-color',
  'border-left',
  'border-right',
  'border-spacing',
  'border-style',
  'border-top',
  'border-width',
  'color',
  'font',
  'font-family',
  'font-size',
  'font-style',
  'font-variant',
  'font-stretch',
  'font-weight',
  'height',
  'line-height',
  'list-style-type',
  'margin',
  'margin-bottom',
  'margin-left',
  'margin-right',
  'margin-top',
  'padding',
  'padding-bottom',
  'padding-left',
  'padding-right',
  'padding-top',
  'text-align',
  'text-decoration',
  'vertical-align',
  'white-space',
  'width'
])

// Safe presentation that remains read-only because Lexical does not round-trip it.
export const PRESERVED_STYLE_PROPERTIES = new Set([
  'direction',
  'unicode-bidi',
  'float',
  'table-layout',
  'column-count',
  'column-width',
  'column-gap',
  'column-rule-width',
  'column-rule-style',
  'column-rule-color',
  'column-span',
  'column-fill',
  'break-before',
  'break-after',
  'break-inside',
  'order',
  'position',
  'top',
  'right',
  'bottom',
  'left',
  'z-index',
  'clear',
  'display',
  'opacity',
  'visibility',
  'transform',
  'transform-origin',
  'letter-spacing',
  'word-spacing',
  'text-transform',
  'text-shadow',
  'box-shadow',
  'border-radius',
  'overflow',
  'overflow-x',
  'overflow-y',
  'max-width',
  'min-width',
  'max-height',
  'min-height',
  'box-sizing',
  'text-overflow',
  'word-break',
  'writing-mode',
  'text-orientation',
  'text-indent',
  'object-fit',
  'object-position',
  'flex',
  'flex-direction',
  'flex-wrap',
  'flex-grow',
  'flex-shrink',
  'flex-basis',
  'align-items',
  'align-content',
  'align-self',
  'justify-content',
  'justify-items',
  'justify-self',
  'gap',
  'row-gap',
  'column-gap',
  'grid-template-columns',
  'grid-template-rows',
  'grid-column',
  'grid-row'
])

const UNSAFE_STYLE_RESOURCE =
  /(?:url\s*\(|(?:-webkit-)?image-set\s*\(|(?:image|cross-fade|element|-moz-element|paint|src)\s*\(|expression\s*\(|javascript:|@import|behavior\s*:|(?:https?|data|cid|blob|file):|\/\/|\\|\/\*)/i

export function sanitizeComposerStyle(style: unknown): string {
  if (typeof style !== 'string') return ''
  return cssDeclarations(style)
    .filter(
      ({ property, value }) =>
        (COMPOSER_STYLE_PROPERTIES.has(property) || PRESERVED_STYLE_PROPERTIES.has(property)) &&
        !UNSAFE_STYLE_RESOURCE.test(value)
    )
    .map(({ raw }) => raw)
    .join('; ')
}

// Keep outgoing mail isolated from MessageBody's singleton: that sanitizer has
// an inbound-mail hook which adds browser-only target/rel attributes to links.
let outgoingPurifier: DOMPurify | null = null
let importPurifier: DOMPurify | null = null
const hooked = new WeakSet<DOMPurify>()
const outgoingDataHooked = new WeakSet<DOMPurify>()
const COMPOSER_DATA_ATTRIBUTES = new Set([
  'data-attn-cid',
  'data-attn-opaque',
  'data-attn-remote-src',
  'data-attn-signature',
  'data-smartmail',
  'data-surl'
])

export function isGmailSignatureAttributes(
  className: string | null | undefined,
  smartmail: string | null | undefined
): boolean {
  if (className !== null && className !== undefined && className.trim() !== 'gmail_signature') {
    return false
  }
  if (smartmail !== null && smartmail !== undefined && smartmail !== 'gmail_signature') return false
  return className?.trim() === 'gmail_signature' || smartmail === 'gmail_signature'
}

export function isGmailSignaturePrefixClass(className: string | null | undefined): boolean {
  return className?.trim() === 'gmail_signature_prefix'
}

function installStyleHook(purifier: DOMPurify): void {
  if (hooked.has(purifier)) return
  hooked.add(purifier)
  purifier.addHook('afterSanitizeAttributes', (node) => {
    const element = node as Element
    if (typeof element.getAttribute !== 'function') return
    const style = element.getAttribute('style')
    if (!style) return
    const clean = sanitizeComposerStyle(style)
    if (clean) element.setAttribute('style', clean)
    else element.removeAttribute('style')
  })
}

const SAFE_URI = /^(?:(?:https?|mailto|cid):|data:image\/(?:png|jpeg|gif|webp);base64,)/i
/**
 * Schemes an authored composer link may carry. Kept beside the outgoing
 * allowlist because the toolbar's validator and Lexical's own `validateUrl`
 * have to agree with what serialization will let through (review R8).
 */
export const COMPOSER_LINK_SCHEMES = ['https', 'http', 'mailto']
/**
 * Presentational table attributes real mail still ships (SPEC F6). They
 * carry no URL and run nothing, but every legacy mail client honours them, so
 * dropping them silently repainted a table on open. They are deliberately *not*
 * in the editor's representable set (`preserve.ts`), so a table carrying them
 * freezes whole as a byte-exact opaque region rather than being edited lossily.
 * `background` stays out: its value is a URL and belongs to the image policy.
 */
const LEGACY_TABLE_ATTRIBUTES = ['align', 'valign', 'bgcolor', 'border', 'cellpadding', 'cellspacing']
export const LEGACY_FONT_ATTRIBUTES = ['face', 'color', 'size'] as const
const TABLE_ELEMENTS = new Set(['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th'])
// Values like `#eeeeee` or `center` are not URIs, and ALLOWED_URI_REGEXP is
// applied to every attribute value DOMPurify does not know is URI-free — which
// is exactly how these were being stripped before #18a.
const URI_SAFE_ATTRIBUTES = [
  'lang',
  'aria-label',
  'width',
  'height',
  'colspan',
  'rowspan',
  'start',
  ...LEGACY_TABLE_ATTRIBUTES,
  ...LEGACY_FONT_ATTRIBUTES
]

const directionHooked = new WeakSet<DOMPurify>()

/**
 * `dir` and `target` are the two attributes both composer purifiers keep, and
 * both used to spell out the same pair of hooks (review R14). DOMPurify's own
 * value checks can drop them, so the first hook pins the values worth keeping
 * and the second removes anything else that got through.
 */
function installDirectionAndTargetHook(purifier: DOMPurify): void {
  if (directionHooked.has(purifier)) return
  directionHooked.add(purifier)
  purifier.addHook('uponSanitizeAttribute', (_node, data) => {
    const name = data.attrName.toLowerCase()
    if (name === 'dir' && VALID_DIRECTION.test(data.attrValue)) data.forceKeepAttr = true
    if (name === 'target' && ALLOWED_TARGETS.has(data.attrValue)) data.forceKeepAttr = true
  })
  purifier.addHook('afterSanitizeAttributes', (node) => {
    const element = node as Element
    if (typeof element.getAttribute !== 'function') return
    const direction = element.getAttribute('dir')
    if (direction && !VALID_DIRECTION.test(direction)) element.removeAttribute('dir')
    const target = element.getAttribute('target')
    if (target && !ALLOWED_TARGETS.has(target)) element.removeAttribute('target')
  })
}

const VALID_DIRECTION = /^(?:ltr|rtl|auto)$/i
const ALLOWED_TARGETS = new Set(['_blank', '_self'])

const legacyTableHooked = new WeakSet<DOMPurify>()

/** Keep presentation attributes on their native elements; none of these values are resource URLs. */
function installLegacyTableAttributeHook(purifier: DOMPurify): void {
  if (legacyTableHooked.has(purifier)) return
  legacyTableHooked.add(purifier)
  purifier.addHook('afterSanitizeAttributes', (node) => {
    const element = node as Element
    if (typeof element.getAttribute !== 'function') return
    if (!TABLE_ELEMENTS.has(element.tagName.toLowerCase())) {
      for (const attribute of LEGACY_TABLE_ATTRIBUTES) element.removeAttribute(attribute)
    }
    if (element.tagName.toLowerCase() !== 'font') {
      for (const attribute of LEGACY_FONT_ATTRIBUTES) element.removeAttribute(attribute)
    }
  })
}

function purifier(): DOMPurify {
  outgoingPurifier ??= createDOMPurify(window)
  installStyleHook(outgoingPurifier)
  installLegacyTableAttributeHook(outgoingPurifier)
  installDirectionAndTargetHook(outgoingPurifier)
  if (!outgoingDataHooked.has(outgoingPurifier)) {
    outgoingDataHooked.add(outgoingPurifier)
    outgoingPurifier.addHook('afterSanitizeAttributes', (node) => {
      const element = node as Element
      if (typeof element.getAttributeNames !== 'function') return
      for (const attribute of element.getAttributeNames()) {
        if (attribute.startsWith('data-') && !COMPOSER_DATA_ATTRIBUTES.has(attribute)) {
          element.removeAttribute(attribute)
        }
      }
      const isGmailSignature =
        element.tagName.toLowerCase() === 'div' &&
        isGmailSignatureAttributes(element.getAttribute('class'), element.getAttribute('data-smartmail'))
      const isGmailSignaturePrefix =
        element.tagName.toLowerCase() === 'span' && isGmailSignaturePrefixClass(element.getAttribute('class'))
      if (!isGmailSignature && !isGmailSignaturePrefix) {
        element.removeAttribute('class')
      }
      if (!isGmailSignature) element.removeAttribute('data-smartmail')
      // Only an anchor navigates, so the link attributes belong to anchors
      // alone; the shared hook has already vetted the value.
      if (element.tagName.toLowerCase() !== 'a') {
        element.removeAttribute('rel')
        element.removeAttribute('target')
      }
    })
  }
  return outgoingPurifier
}

export function sanitizeOutgoingHtml(html: string): string {
  return purifier().sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR: [
      'href',
      'src',
      'alt',
      'aria-label',
      'role',
      'title',
      'class',
      'dir',
      'lang',
      'rel',
      'target',
      'width',
      'height',
      'colspan',
      'rowspan',
      'start',
      ...LEGACY_FONT_ATTRIBUTES,
      ...LEGACY_TABLE_ATTRIBUTES,
      'style',
      'data-attn-cid',
      'data-attn-opaque',
      'data-attn-signature',
      'data-smartmail',
      'data-surl'
    ],
    ALLOW_ARIA_ATTR: false,
    // The composer owns two namespaced data attributes: one maps a rendered
    // data URL back to cid: during serialization and one carries a sanitized
    // opaque-region token. It also preserves Gmail's data-surl CID locator
    // and the constrained marker on its editable signature wrapper.
    // DOMPurify otherwise strips them even when listed in ALLOWED_ATTR, which
    // would silently lose inline images or preserved HTML.
    ALLOW_DATA_ATTR: true,
    ADD_URI_SAFE_ATTR: URI_SAFE_ATTRIBUTES,
    ALLOWED_URI_REGEXP: SAFE_URI
  })
}

/** Broad safe import pass; unsupported-but-safe elements are made opaque afterwards. */
export function sanitizeDraftHtmlForImport(html: string): string {
  importPurifier ??= createDOMPurify(window)
  installStyleHook(importPurifier)
  installLegacyTableAttributeHook(importPurifier)
  installDirectionAndTargetHook(importPurifier)
  return importPurifier.sanitize(html, {
    ADD_ATTR: ['dir', 'target', 'aria-label'],
    FORBID_TAGS: ['script', 'style', 'form', 'input', 'button', 'select', 'textarea', 'iframe', 'object'],
    ADD_URI_SAFE_ATTR: URI_SAFE_ATTRIBUTES,
    ALLOWED_URI_REGEXP: SAFE_URI,
    ALLOW_ARIA_ATTR: false
  })
}

export function sanitizeComposerImageSource(source: unknown): string {
  if (typeof source !== 'string') return ''
  // Build the probe in an inert document: an <img> created in the LIVE
  // document starts fetching the moment src is assigned, even while detached
  // — a real network request for a remote source before any policy ran
  // (PR #101 review). Documents without a browsing context never load.
  const inert = document.implementation.createHTMLDocument('')
  const image = inert.createElement('img')
  image.setAttribute('src', source)
  const safe = new DOMParser().parseFromString(sanitizeDraftHtmlForImport(image.outerHTML), 'text/html')
  return safe.body.querySelector('img')?.getAttribute('src') ?? ''
}
