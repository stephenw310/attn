import { type DefaultTreeAdapterTypes, parseFragment } from 'parse5'
import { COMPOSER_STYLE_PROPERTIES, isGmailSignatureAttributes, sanitizeDraftHtmlForImport } from './sanitize'

const REPRESENTABLE_TAGS = new Set([
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
  'img',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td'
])

const GLOBAL_ATTRIBUTES = new Set(['style', 'title', 'dir'])
const TAG_ATTRIBUTES: Readonly<Record<string, ReadonlySet<string>>> = {
  a: new Set(['href', 'rel', 'target']),
  img: new Set(['src', 'alt', 'width', 'height', 'data-attn-cid', 'data-surl']),
  ol: new Set(['start']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan'])
}

const GMAIL_SIGNATURE_ATTRIBUTES = new Set(['class', 'data-smartmail'])

/**
 * Classes that carry meaning rather than paint. Attn's trim boundary and
 * surface classification key on these, and so does Gmail's own quote
 * collapsing, so they must survive a round trip byte-for-byte.
 */
const STRUCTURAL_CLASSES = new Set([
  'gmail_attr',
  'gmail_quote',
  'gmail_quote_container',
  'gmail_signature',
  'gmail_signature_prefix'
])

function hasStylesheetMarkup(html: string): boolean {
  return /<style[\s>]/i.test(html)
}

/**
 * A class paints only when a stylesheet targets it, and a draft body carries no
 * stylesheet of its own. Gmail's editor classes — `Q6ibn ng` around typed text,
 * `gmail_default` on a wrapper — are therefore inert, and freezing the user's
 * own words to preserve them buys nothing.
 */
function isInertClass(value: string, hasStylesheet: boolean): boolean {
  if (hasStylesheet) return false
  return !value.split(/\s+/).some((name) => STRUCTURAL_CLASSES.has(name))
}

/**
 * An allowlist rather than a list of block tags, because the block side is
 * open-ended: `table`, `div`, `p` and `blockquote` all belong there, and so
 * does any unknown element a sender invents. Getting this wrong is visible —
 * an inline marker makes the editor render the region as a narrow inline box,
 * which squeezes a table-based newsletter well below its designed width.
 */
const INLINE_TAGS = new Set([
  'a',
  'abbr',
  'b',
  'bdi',
  'bdo',
  'big',
  'br',
  'cite',
  'code',
  'data',
  'dfn',
  'em',
  'font',
  'i',
  'img',
  'kbd',
  'mark',
  'q',
  's',
  'samp',
  'small',
  'span',
  'strike',
  'strong',
  'sub',
  'sup',
  'time',
  'tt',
  'u',
  'var',
  'wbr'
])

const INHERITED_TEXT_STYLES = new Set([
  'background-color',
  'color',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'line-height',
  'text-decoration'
])

function styleDeclarations(style: string): Map<string, string> {
  const declarations = new Map<string, string>()
  for (const declaration of style.split(';')) {
    const separator = declaration.indexOf(':')
    if (separator <= 0) continue
    declarations.set(
      declaration.slice(0, separator).trim().toLowerCase(),
      declaration.slice(separator + 1).trim()
    )
  }
  return declarations
}

/**
 * Lexical imports inline text styles from spans, while Gmail commonly places
 * inherited typography on a paragraph or div. Materialize the computed text
 * style on each original text run before import so editing a sibling cannot
 * erase those supported declarations.
 */
function materializeInheritedTextStyles(document: Document): void {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const textNodes: Text[] = []
  while (walker.nextNode()) textNodes.push(walker.currentNode as Text)

  for (const textNode of textNodes) {
    if (!textNode.data) continue
    const ancestors: Element[] = []
    let ancestor = textNode.parentElement
    while (ancestor && ancestor !== document.body) {
      ancestors.unshift(ancestor)
      ancestor = ancestor.parentElement
    }
    const inherited = new Map<string, string>()
    for (const element of ancestors) {
      for (const [property, value] of styleDeclarations(element.getAttribute('style') ?? '')) {
        if (INHERITED_TEXT_STYLES.has(property)) inherited.set(property, value)
      }
    }
    if (inherited.size === 0) continue
    const span = document.createElement('span')
    span.setAttribute('style', [...inherited].map(([property, value]) => `${property}: ${value}`).join('; '))
    textNode.replaceWith(span)
    span.append(textNode)
  }

  for (const element of document.body.querySelectorAll<HTMLElement>('[style]')) {
    if (element.tagName.toLowerCase() === 'span') continue
    const remaining = [...styleDeclarations(element.getAttribute('style') ?? '')].filter(
      ([property]) => !INHERITED_TEXT_STYLES.has(property)
    )
    if (remaining.length === 0) element.removeAttribute('style')
    else {
      element.setAttribute('style', remaining.map(([property, value]) => `${property}: ${value}`).join('; '))
    }
  }
}

function unsupportedReason(element: Element, hasStylesheet: boolean): string | null {
  const tag = element.tagName.toLowerCase()
  if (!REPRESENTABLE_TAGS.has(tag)) return `<${tag}>`
  const attributes = new Map(
    element.getAttributeNames().map((name) => [name, element.getAttribute(name) ?? ''])
  )
  const gmailSignature =
    tag === 'div' && isGmailSignatureAttributes(attributes.get('class'), attributes.get('data-smartmail'))
  const tagAttributes = TAG_ATTRIBUTES[tag] ?? new Set<string>()
  for (const attribute of element.getAttributeNames()) {
    if (attribute === 'class' && isInertClass(attributes.get('class') ?? '', hasStylesheet)) continue
    if (
      !GLOBAL_ATTRIBUTES.has(attribute) &&
      !tagAttributes.has(attribute) &&
      !(gmailSignature && GMAIL_SIGNATURE_ATTRIBUTES.has(attribute))
    ) {
      return `${tag}[${attribute}]`
    }
  }
  const style = element.getAttribute('style')
  if (style) {
    for (const declaration of style.split(';')) {
      const separator = declaration.indexOf(':')
      if (separator <= 0) continue
      const property = declaration.slice(0, separator).trim().toLowerCase()
      if (!COMPOSER_STYLE_PROPERTIES.has(property)) return `${tag}[style:${property}]`
    }
  }
  return null
}

function sourceUnsupportedReason(
  element: DefaultTreeAdapterTypes.Element,
  hasStylesheet: boolean
): string | null {
  const tag = element.tagName.toLowerCase()
  if (!REPRESENTABLE_TAGS.has(tag)) return `<${tag}>`
  const attributes = new Map(element.attrs.map((attribute) => [attribute.name, attribute.value]))
  const gmailSignature =
    tag === 'div' && isGmailSignatureAttributes(attributes.get('class'), attributes.get('data-smartmail'))
  const tagAttributes = TAG_ATTRIBUTES[tag] ?? new Set<string>()
  for (const attribute of element.attrs) {
    const inertClass = attribute.name === 'class' && isInertClass(attribute.value, hasStylesheet)
    if (
      !inertClass &&
      !GLOBAL_ATTRIBUTES.has(attribute.name) &&
      !tagAttributes.has(attribute.name) &&
      !(gmailSignature && GMAIL_SIGNATURE_ATTRIBUTES.has(attribute.name))
    ) {
      return `${tag}[${attribute.name}]`
    }
    if (attribute.name !== 'style') continue
    for (const declaration of attribute.value.split(';')) {
      const separator = declaration.indexOf(':')
      if (separator <= 0) continue
      const property = declaration.slice(0, separator).trim().toLowerCase()
      if (!COMPOSER_STYLE_PROPERTIES.has(property)) return `${tag}[style:${property}]`
    }
  }
  return null
}

/**
 * `hasStylesheet` is passed in when judging a fragment lifted out of a larger
 * document: the fragment has lost the context that decides whether a class
 * paints, and the two walks must agree or a region freezes on one pass and not
 * the other.
 */
export function draftHtmlFidelityIssues(
  html: string,
  hasStylesheet: boolean = hasStylesheetMarkup(html)
): string[] {
  const document = new DOMParser().parseFromString(html, 'text/html')
  return [...document.body.querySelectorAll('*')]
    .map((element) => unsupportedReason(element, hasStylesheet))
    .filter((reason): reason is string => reason !== null)
}

export function encodeOpaqueHtml(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '')
}

export function decodeOpaqueHtml(value: string): string {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '='))
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)))
}

export function opaqueHtmlText(value: string): string {
  return new DOMParser().parseFromString(decodeOpaqueHtml(value), 'text/html').body.textContent ?? ''
}

interface OpaqueSourceRegion {
  start: number
  end: number
  tag: string
  /**
   * Every unsupported node sits in exactly one top-most region's subtree, so
   * issues are reported per region rather than as one flat list — a region that
   * turns out to preserve nothing must take its nested issues with it.
   */
  issues: string[]
}

/**
 * Elements the HTML parser only accepts inside a table. A region cut at one of
 * these cannot stand alone: its slice, parsed in a body context, drops the
 * `td`/`tr` and keeps only its text, and any marker put in its place is
 * foster-parented out of the table by the final parse — either way the cell's
 * content lands beside the table with no banner. Such a region is lifted to the
 * nearest enclosing table so the whole table freezes as one exact unit.
 */
const TABLE_SCOPED_TAGS = new Set(['caption', 'col', 'colgroup', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th'])

function opaqueSourceRegions(html: string, hasStylesheet: boolean): OpaqueSourceRegion[] {
  const fragment = parseFragment(html, { sourceCodeLocationInfo: true })
  const promotedTables = new Map<DefaultTreeAdapterTypes.Element, string>()
  const promote = (
    node: DefaultTreeAdapterTypes.ChildNode,
    table: DefaultTreeAdapterTypes.Element | null
  ): void => {
    if (!('tagName' in node)) return
    const tag = node.tagName.toLowerCase()
    if (table && TABLE_SCOPED_TAGS.has(tag) && !promotedTables.has(table)) {
      const reason = sourceUnsupportedReason(node, hasStylesheet)
      if (reason) promotedTables.set(table, reason)
    }
    const nearestTable = tag === 'table' ? node : table
    for (const child of node.childNodes) promote(child, nearestTable)
  }
  for (const child of fragment.childNodes) promote(child, null)

  const regions: OpaqueSourceRegion[] = []
  const visit = (node: DefaultTreeAdapterTypes.ChildNode, owner: OpaqueSourceRegion | null): void => {
    if (!('tagName' in node)) return
    const reason = promotedTables.get(node) ?? sourceUnsupportedReason(node, hasStylesheet)
    let region = owner
    if (reason && !owner) {
      const location = node.sourceCodeLocation
      if (!location) return
      region = { start: location.startOffset, end: location.endOffset, tag: node.tagName, issues: [] }
      regions.push(region)
    }
    // A promoted table reports the cell's reason, and the cell then reports it
    // again on its own visit; the banner reads one list, so keep it distinct.
    if (reason && region && !region.issues.includes(reason)) region.issues.push(reason)
    for (const child of node.childNodes) visit(child, region)
  }
  for (const child of fragment.childNodes) visit(child, null)
  return regions
}

/** DOMPurify remains the security authority; serialization differences alone do not make safe HTML lossy. */
export function sanitizedDomMatchesSource(source: string, sanitized: string): boolean {
  const left = parseFragment(source)
  const right = parseFragment(sanitized)
  const children = (node: DefaultTreeAdapterTypes.ParentNode): DefaultTreeAdapterTypes.ChildNode[] =>
    'content' in node ? node.content.childNodes : node.childNodes
  const sameNode = (a: DefaultTreeAdapterTypes.ChildNode, b: DefaultTreeAdapterTypes.ChildNode): boolean => {
    if (a.nodeName !== b.nodeName) return false
    if ('tagName' in a && 'tagName' in b) {
      const leftAttributes = a.attrs
        .map(
          (attribute) =>
            `${attribute.namespace ?? ''}\0${attribute.prefix ?? ''}\0${attribute.name}\0${attribute.value}`
        )
        .sort()
      const rightAttributes = b.attrs
        .map(
          (attribute) =>
            `${attribute.namespace ?? ''}\0${attribute.prefix ?? ''}\0${attribute.name}\0${attribute.value}`
        )
        .sort()
      if (
        a.namespaceURI !== b.namespaceURI ||
        leftAttributes.length !== rightAttributes.length ||
        leftAttributes.some((attribute, index) => attribute !== rightAttributes[index])
      ) {
        return false
      }
    }
    if ('value' in a && 'value' in b && a.value !== b.value) return false
    if ('data' in a && 'data' in b && a.data !== b.data) return false
    if (!('childNodes' in a) || !('childNodes' in b)) return true
    const leftChildren = children(a)
    const rightChildren = children(b)
    return (
      leftChildren.length === rightChildren.length &&
      leftChildren.every((child, index) => sameNode(child, rightChildren[index]))
    )
  }
  return (
    left.childNodes.length === right.childNodes.length &&
    left.childNodes.every((child, index) => sameNode(child, right.childNodes[index]))
  )
}

/** Replace only top-most unsupported regions so nested source survives as one exact unit. */
export function prepareHtmlForEditor(html: string): { html: string; issues: string[] } {
  if (!html.trim()) return { html: '', issues: [] }
  const issues: string[] = []
  // Decided once, from the whole document, and reused for every region below.
  const hasStylesheet = hasStylesheetMarkup(html)
  let marked = html
  for (const region of opaqueSourceRegions(html, hasStylesheet).sort(
    (left, right) => right.start - left.start
  )) {
    const source = html.slice(region.start, region.end)
    const sanitized = sanitizeDraftHtmlForImport(source)
    const preserved = sanitizedDomMatchesSource(source, sanitized) ? source : sanitized
    // Freezing is for content the editor cannot represent. When the sanitizer
    // has already dropped whatever was unsupported — Gmail's `<br clear="all">`
    // being the everyday case — what is left is ordinary editable markup, and
    // making it read-only would preserve nothing while costing the user the
    // ability to edit it and showing a banner about formatting that is gone.
    let replacement = ''
    if (preserved && draftHtmlFidelityIssues(preserved, hasStylesheet).length > 0) {
      const markerTag = INLINE_TAGS.has(region.tag) ? 'span' : 'div'
      replacement = `<${markerTag} data-attn-opaque="${encodeOpaqueHtml(preserved)}"></${markerTag}>`
      issues.unshift(...region.issues)
    } else {
      replacement = preserved
    }
    marked = `${marked.slice(0, region.start)}${replacement}${marked.slice(region.end)}`
  }
  const safe = sanitizeDraftHtmlForImport(marked)
  const document = new DOMParser().parseFromString(safe, 'text/html')
  materializeInheritedTextStyles(document)
  return { html: document.body.innerHTML, issues }
}

const OPAQUE_MARKER = /<(span|div)\s+data-attn-opaque="([A-Za-z0-9_-]+)"\s*><\/\1>/gi

export function restoreOpaqueHtml(html: string): string {
  return html.replace(OPAQUE_MARKER, (_match, _tag: string, encoded: string) => decodeOpaqueHtml(encoded))
}
