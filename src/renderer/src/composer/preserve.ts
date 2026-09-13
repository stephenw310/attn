import { type DefaultTreeAdapterTypes, parseFragment } from 'parse5'
import { cssDeclarations } from '../../../shared/css'
import {
  COMPOSER_STYLE_PROPERTIES,
  isGmailSignatureAttributes,
  isGmailSignaturePrefixClass,
  LEGACY_FONT_ATTRIBUTES,
  sanitizeDraftHtmlForImport
} from './sanitize'

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
  'font',
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
  font: new Set(LEGACY_FONT_ATTRIBUTES),
  img: new Set(['src', 'alt', 'width', 'height', 'data-attn-cid', 'data-surl']),
  ol: new Set(['start']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan'])
}

const GMAIL_SIGNATURE_ATTRIBUTES = new Set(['class', 'data-smartmail'])
/** The optional footer's marker (T32B); its element stays fully editable. */
const ATTN_FOOTER_ATTRIBUTES = new Set(['data-attn-signature'])

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

/**
 * CSS-inherited typography only. `background-color` is deliberately absent: it
 * does not inherit, and materializing it onto text runs — then stripping it
 * from their ancestors — turns a shaded table cell or a highlight block into a
 * text highlight that no longer fills its block.
 */
const INHERITED_TEXT_STYLES = new Set([
  'color',
  'font-family',
  'font-size',
  'font-style',
  'font-variant',
  'font-stretch',
  'font-weight',
  'line-height',
  'text-decoration',
  'white-space'
])

/**
 * Lexical imports inline text styles from spans, while Gmail commonly places
 * inherited typography on a paragraph or div. Materialize the computed text
 * style on each original text run before import so editing a sibling cannot
 * erase those supported declarations.
 */
function materializeInheritedTextStyles(document: Document): void {
  // A declaration on the semantic element replaces its own default decoration.
  // A descendant declaration cannot remove decoration propagated by an ancestor.
  for (const element of document.querySelectorAll<HTMLElement>('u[style], s[style], strike[style]')) {
    if (!/^none(?:\s|$)/.test(element.style.textDecoration.trim())) continue
    const span = document.createElement('span')
    for (const attribute of element.attributes) span.setAttribute(attribute.name, attribute.value)
    span.append(...element.childNodes)
    element.replaceWith(span)
  }
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
      // Semantic emphasis participates in the cascade before the element's CSS.
      if (['B', 'STRONG'].includes(element.tagName)) inherited.set('font-weight', 'bold')
      if (['I', 'EM'].includes(element.tagName)) inherited.set('font-style', 'italic')
      if (element.tagName === 'U') inherited.set('text-decoration', 'underline')
      if (['S', 'STRIKE'].includes(element.tagName)) inherited.set('text-decoration', 'line-through')
      for (const { property, value } of cssDeclarations(element.getAttribute('style') ?? '')) {
        if (
          INHERITED_TEXT_STYLES.has(property) ||
          (element.tagName === 'SPAN' && COMPOSER_STYLE_PROPERTIES.has(property))
        )
          inherited.set(property, value)
      }
    }
    if (inherited.size === 0) continue
    const span = document.createElement('span')
    span.setAttribute('style', [...inherited].map(([property, value]) => `${property}: ${value}`).join('; '))
    if (['pre', 'pre-wrap', 'break-spaces'].includes(inherited.get('white-space') ?? '')) {
      const fragment = document.createDocumentFragment()
      for (const part of textNode.data.split(/(\r\n|\r|\n|\t)/)) {
        if (!part) continue
        if (/^[\r\n]+$/.test(part)) fragment.append(document.createElement('br'))
        else {
          const run = span.cloneNode() as HTMLElement
          run.textContent = part
          fragment.append(run)
        }
      }
      textNode.replaceWith(fragment)
    } else {
      textNode.replaceWith(span)
      span.append(textNode)
    }
  }

  for (const element of document.body.querySelectorAll<HTMLElement>('[style]')) {
    if (element.tagName.toLowerCase() === 'span') continue
    const remaining = cssDeclarations(element.getAttribute('style') ?? '').filter(
      ({ property }) => !INHERITED_TEXT_STYLES.has(property)
    )
    if (remaining.length === 0) element.removeAttribute('style')
    else {
      element.setAttribute(
        'style',
        remaining.map(({ property, value }) => `${property}: ${value}`).join('; ')
      )
    }
  }
}

/**
 * One element, as either node model. The same rule set used to be written
 * twice — once over the DOM for the fidelity walk, once over parse5 for the
 * source-offset walk (review R14) — and the two could disagree about what the
 * editor can represent, which freezes a region on one pass and not the other.
 */
interface ElementShape {
  tag: string
  attributes: { name: string; value: string }[]
}

function domElementShape(element: Element): ElementShape {
  return {
    tag: element.tagName.toLowerCase(),
    attributes: element.getAttributeNames().map((name) => ({ name, value: element.getAttribute(name) ?? '' }))
  }
}

function sourceElementShape(element: DefaultTreeAdapterTypes.Element): ElementShape {
  return {
    tag: element.tagName.toLowerCase(),
    attributes: element.attrs.map(({ name, value }) => ({ name, value }))
  }
}

/** Why the editor cannot represent this element losslessly, or null. */
function unsupportedReason({ tag, attributes }: ElementShape, hasStylesheet: boolean): string | null {
  if (!REPRESENTABLE_TAGS.has(tag)) return `<${tag}>`
  const values = new Map(attributes.map(({ name, value }) => [name, value]))
  const gmailSignature =
    tag === 'div' && isGmailSignatureAttributes(values.get('class'), values.get('data-smartmail'))
  const attnFooter = tag === 'div' && values.get('data-attn-signature') === 'footer'
  const gmailSignaturePrefix = tag === 'span' && isGmailSignaturePrefixClass(values.get('class'))
  const tagAttributes = TAG_ATTRIBUTES[tag] ?? new Set<string>()
  for (const { name, value } of attributes) {
    if (name === 'class' && isInertClass(value, hasStylesheet)) continue
    if (
      !GLOBAL_ATTRIBUTES.has(name) &&
      !tagAttributes.has(name) &&
      !(gmailSignaturePrefix && name === 'class') &&
      !(gmailSignature && GMAIL_SIGNATURE_ATTRIBUTES.has(name)) &&
      !(attnFooter && ATTN_FOOTER_ATTRIBUTES.has(name))
    ) {
      return `${tag}[${name}]`
    }
  }
  for (const { property, value } of cssDeclarations(values.get('style') ?? '')) {
    if (!COMPOSER_STYLE_PROPERTIES.has(property)) return `${tag}[style:${property}]`
    if (property === 'list-style-type' || property === 'font') return `${tag}[style:${property}]`
    if (
      ['table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th'].includes(tag) &&
      !INHERITED_TEXT_STYLES.has(property) &&
      !(['td', 'th'].includes(tag) && property === 'background-color')
    )
      return `${tag}[table:${property}]`
    // Text styles are materialized on editable runs. Block paint and geometry
    // are not serialized by the paragraph/list/quote nodes.
    if (
      ['p', 'div', 'blockquote', 'ul', 'ol', 'li'].includes(tag) &&
      !INHERITED_TEXT_STYLES.has(property) &&
      property !== 'text-align' &&
      !(/^(margin|padding)/.test(property) && /^(?:0(?:\.0+)?(?:px)?\s*){1,4}$/.test(value))
    )
      return `${tag}[block:${property}]`
    if (
      tag === 'span' &&
      /^(border|padding|margin|width$|height$)/.test(property) &&
      !/^(none|0(?:px)?|auto)$/.test(value)
    )
      return `span[box:${property}]`
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
    .map((element) => unsupportedReason(domElementShape(element), hasStylesheet))
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
  const promotedContainers = new Map<DefaultTreeAdapterTypes.Element, string>()
  const promote = (
    node: DefaultTreeAdapterTypes.ChildNode,
    table: DefaultTreeAdapterTypes.Element | null,
    list: DefaultTreeAdapterTypes.Element | null
  ): void => {
    if (!('tagName' in node)) return
    const tag = node.tagName.toLowerCase()
    if (table && TABLE_SCOPED_TAGS.has(tag) && !promotedContainers.has(table)) {
      const reason = unsupportedReason(sourceElementShape(node), hasStylesheet)
      if (reason) promotedContainers.set(table, reason)
    }
    if (list && tag === 'li' && !promotedContainers.has(list)) {
      const reason = unsupportedReason(sourceElementShape(node), hasStylesheet)
      if (reason) promotedContainers.set(list, reason)
    }
    const nearestTable = tag === 'table' ? node : table
    const nearestList = tag === 'ul' || tag === 'ol' ? node : list
    for (const child of node.childNodes) promote(child, nearestTable, nearestList)
  }
  for (const child of fragment.childNodes) promote(child, null, null)

  const regions: OpaqueSourceRegion[] = []
  const visit = (node: DefaultTreeAdapterTypes.ChildNode, owner: OpaqueSourceRegion | null): void => {
    if (!('tagName' in node)) return
    const reason = promotedContainers.get(node) ?? unsupportedReason(sourceElementShape(node), hasStylesheet)
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

/** Group only an adjacent marked separator with its signature, never ordinary authored dashes. */
function groupGmailSignaturePrefixes(document: Document): void {
  const previousContent = (node: Node): ChildNode | null => {
    let previous = node.previousSibling
    while (previous?.nodeType === Node.TEXT_NODE && !previous.textContent?.trim()) {
      previous = previous.previousSibling
    }
    return previous
  }
  for (const signature of document.querySelectorAll(
    'div.gmail_signature, div[data-smartmail="gmail_signature"]'
  )) {
    const lineBreak = previousContent(signature)
    if (!(lineBreak instanceof HTMLBRElement)) continue
    const prefix = previousContent(lineBreak)
    if (!(prefix instanceof HTMLSpanElement) || !isGmailSignaturePrefixClass(prefix.getAttribute('class'))) {
      continue
    }
    signature.prepend(prefix)
    lineBreak.remove()
  }
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
  groupGmailSignaturePrefixes(document)
  // Lexical's whitespace walker does not list FONT as inline. This import-only
  // hint keeps spaces between adjacent fonts; the node's style sanitizer drops it.
  for (const font of document.body.querySelectorAll<HTMLElement>('font')) {
    font.style.display = 'inline'
  }
  return { html: document.body.innerHTML, issues }
}

const OPAQUE_MARKER = /<(span|div)\s+data-attn-opaque="([A-Za-z0-9_-]+)"\s*><\/\1>/gi

export function restoreOpaqueHtml(html: string): string {
  return html.replace(OPAQUE_MARKER, (_match, _tag: string, encoded: string) => decodeOpaqueHtml(encoded))
}
