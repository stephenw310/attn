import { type DefaultTreeAdapterTypes, parseFragment } from 'parse5'
import { COMPOSER_STYLE_PROPERTIES, sanitizeDraftHtmlForImport } from './sanitize'

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
  a: new Set(['href']),
  img: new Set(['src', 'alt', 'width', 'height', 'data-attn-cid', 'data-surl']),
  ol: new Set(['start']),
  td: new Set(['colspan', 'rowspan']),
  th: new Set(['colspan', 'rowspan'])
}

const BLOCK_TAGS = new Set([
  'address',
  'article',
  'aside',
  'details',
  'dl',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'header',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'main',
  'nav',
  'pre',
  'section'
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

function unsupportedReason(element: Element): string | null {
  const tag = element.tagName.toLowerCase()
  if (!REPRESENTABLE_TAGS.has(tag)) return `<${tag}>`
  const tagAttributes = TAG_ATTRIBUTES[tag] ?? new Set<string>()
  for (const attribute of element.getAttributeNames()) {
    if (!GLOBAL_ATTRIBUTES.has(attribute) && !tagAttributes.has(attribute)) return `${tag}[${attribute}]`
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

function sourceUnsupportedReason(element: DefaultTreeAdapterTypes.Element): string | null {
  const tag = element.tagName.toLowerCase()
  if (!REPRESENTABLE_TAGS.has(tag)) return `<${tag}>`
  const tagAttributes = TAG_ATTRIBUTES[tag] ?? new Set<string>()
  for (const attribute of element.attrs) {
    if (!GLOBAL_ATTRIBUTES.has(attribute.name) && !tagAttributes.has(attribute.name)) {
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

export function draftHtmlFidelityIssues(html: string): string[] {
  const document = new DOMParser().parseFromString(html, 'text/html')
  return [...document.body.querySelectorAll('*')]
    .map(unsupportedReason)
    .filter((reason): reason is string => reason !== null)
}

function encodeOpaque(value: string): string {
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
}

function opaqueSourceRegions(html: string): { regions: OpaqueSourceRegion[]; issues: string[] } {
  const fragment = parseFragment(html, { sourceCodeLocationInfo: true })
  const regions: OpaqueSourceRegion[] = []
  const issues: string[] = []
  const visit = (node: DefaultTreeAdapterTypes.ChildNode, insideOpaque: boolean): void => {
    if (!('tagName' in node)) return
    const reason = sourceUnsupportedReason(node)
    if (reason) issues.push(reason)
    const opaque = insideOpaque || reason !== null
    const location = node.sourceCodeLocation
    if (reason && !insideOpaque && location) {
      regions.push({ start: location.startOffset, end: location.endOffset, tag: node.tagName })
    }
    for (const child of node.childNodes) visit(child, opaque)
  }
  for (const child of fragment.childNodes) visit(child, false)
  return { regions, issues }
}

/** DOMPurify remains the security authority; serialization differences alone do not make safe HTML lossy. */
function sanitizedDomMatchesSource(source: string, sanitized: string): boolean {
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
  const { regions, issues } = opaqueSourceRegions(html)
  let marked = html
  for (const region of regions.sort((left, right) => right.start - left.start)) {
    const source = html.slice(region.start, region.end)
    const sanitized = sanitizeDraftHtmlForImport(source)
    const preserved = sanitizedDomMatchesSource(source, sanitized) ? source : sanitized
    const markerTag = BLOCK_TAGS.has(region.tag) ? 'div' : 'span'
    const marker = preserved
      ? `<${markerTag} data-attn-opaque="${encodeOpaque(preserved)}"></${markerTag}>`
      : ''
    marked = `${marked.slice(0, region.start)}${marker}${marked.slice(region.end)}`
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
