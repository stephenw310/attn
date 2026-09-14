import { cssDeclarations } from '../../../shared/css'
import { REPRESENTABLE_TAGS } from './preserve'
import { COMPOSER_STYLE_PROPERTIES } from './sanitize'

/** Tags the editor edits in place, in the DOM's uppercase spelling. */
const EDITABLE_TAGS = new Set([...REPRESENTABLE_TAGS].map((tag) => tag.toUpperCase()))
/** Tags this pass rewrites into editable ones. Everything else stays on the preservation path. */
const CONVERTED_TAGS =
  'H1 H2 H3 H4 H5 H6 MARK CODE PRE DETAILS SUMMARY FIGURE FIGCAPTION INPUT HR IFRAME VIDEO AUDIO COLGROUP COL'.split(
    ' '
  )
const SUPPORTED_TAGS = new Set([...EDITABLE_TAGS, ...CONVERTED_TAGS])
/** Editor metadata and table presentation the sanitizer keeps but the editor cannot represent. */
const INERT_ATTRIBUTES = new Set([
  'id',
  'role',
  'data-block-id',
  'data-content-editable-leaf',
  'data-is-empty',
  'data-placeholder',
  'contenteditable',
  'spellcheck',
  'tabindex',
  'valign',
  'cellspacing',
  'cellpadding'
])
const INERT_PROPERTIES = new Set([
  '-webkit-text-size-adjust',
  '-webkit-user-select',
  'user-select',
  'caret-color',
  'overflow-wrap',
  'word-wrap'
])

/** Expand ordinary font shorthands using the browser's CSS parser. */
function expandFont(document: Document, value: string): string[] | null {
  const probe = document.createElement('span')
  probe.style.font = value
  if (!probe.style.fontSize || !probe.style.fontFamily) return null
  return ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height']
    .map((name) => [name, probe.style.getPropertyValue(name)])
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}: ${value}`)
}

/** Expand the small paragraph/span stylesheet emitted by macOS rich-text copy. */
function expandCocoaStyles(html: string): string {
  const document = new DOMParser().parseFromString(html, 'text/html')
  if (document.querySelector('meta[name="Generator"]')?.getAttribute('content') !== 'Cocoa HTML Writer') {
    return html
  }
  const styles = [...document.querySelectorAll('style')]
  if (styles.length === 0) return html
  const rules: { selector: string; style: string; blankHeight: boolean }[] = []
  for (const stylesheet of styles) {
    let remaining = stylesheet.textContent?.trim() ?? ''
    while (remaining) {
      // Decline selectors, at-rules, and syntax outside Cocoa's simple text export.
      const match = /^((?:p|span|li|ul|ol|table|tr|td|th)\.[A-Za-z][\w-]*)\s*\{([^{}]*)\}\s*/.exec(remaining)
      if (!match) return html
      const declarations: string[] = []
      let blankHeight = false
      for (const { property, value, raw } of cssDeclarations(match[2])) {
        if (value.includes('!')) return html
        if (property === 'font') {
          const expanded = expandFont(document, value)
          if (!expanded) return html
          declarations.push(...expanded)
        } else if (property === 'min-height' && /^\d+(?:\.\d+)?px$/.test(value)) {
          blankHeight = true
        } else if (COMPOSER_STYLE_PROPERTIES.has(property)) {
          declarations.push(raw)
        }
        // List markers, kerning, and stroke are dropped: the editor draws its
        // own markers and cannot represent the rest, but the text stays editable.
      }
      rules.push({ selector: match[1], style: declarations.join('; '), blankHeight })
      remaining = remaining.slice(match[0].length)
    }
  }
  for (const rule of rules) {
    for (const element of document.querySelectorAll(rule.selector)) {
      // Cocoa gives empty paragraphs a minimum height. Keep their explicit BR,
      // but leave authored minimum-height layouts on the preservation path.
      if (
        rule.blankHeight &&
        (element.tagName !== 'P' ||
          element.textContent?.trim() ||
          [...element.children].some((child) => child.tagName !== 'BR' && child.textContent))
      ) {
        return html
      }
    }
  }
  const inlineStyles = new Map<Element, string>()
  for (const rule of rules) {
    for (const element of document.querySelectorAll(rule.selector)) {
      inlineStyles.set(element, `${inlineStyles.get(element) ?? ''}; ${rule.style}`)
    }
  }
  for (const [element, style] of inlineStyles) {
    element.setAttribute('style', `${style}; ${element.getAttribute('style') ?? ''}`)
  }
  for (const stylesheet of styles) stylesheet.remove()
  // The normal import pipeline still sanitizes all markup and style values.
  return document.body.innerHTML
}

/** The text a browser derives from the markup: one line per block, without source indentation. */
function clipboardTextContent(document: Document): string {
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  while (walker.nextNode()) texts.push(walker.currentNode as Text)
  for (const text of texts) {
    if (!text.parentElement?.closest('pre')) text.data = text.data.replace(/\s+/g, ' ')
  }
  for (const node of document.querySelectorAll('br')) node.replaceWith(document.createTextNode('\n'))
  for (const node of document.querySelectorAll('p,div,li,h1,h2,h3,h4,h5,h6,tr,blockquote,pre')) {
    if (!node.textContent?.endsWith('\n')) node.append(document.createTextNode('\n'))
  }
  return (document.body.textContent ?? '')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
}

function plainTextParagraph(document: Document, text: string): string {
  const paragraph = document.createElement('p')
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  for (const [index, line] of lines.entries()) {
    if (index) paragraph.append(document.createElement('br'))
    paragraph.append(document.createTextNode(line))
  }
  return paragraph.outerHTML
}

/** Normalize new clipboard content into the editor's email-friendly vocabulary. */
export function normalizeClipboardHtml(html: string, plainText?: string): string {
  const expanded = expandCocoaStyles(html)
  const document = new DOMParser().parseFromString(expanded, 'text/html')
  for (const node of document.querySelectorAll('script,template,noscript')) node.remove()
  const stylesheets = [...document.querySelectorAll('style')]
  // Only Cocoa's bounded text stylesheet is converted. Other CSS is dropped and
  // the markup stays editable, unless the stylesheet generates content the
  // markup alone would misrepresent; then the clipboard text is the honest paste.
  if (
    stylesheets.some((sheet) =>
      /::?(?:before|after|marker)\b|(?:^|[^\w-])content\s*:/i.test(sheet.textContent ?? '')
    )
  ) {
    for (const sheet of stylesheets) sheet.remove()
    return plainTextParagraph(document, plainText || clipboardTextContent(document))
  }
  for (const sheet of stylesheets) sheet.remove()
  const preserved = new WeakSet<Element>()
  for (const element of document.body.querySelectorAll('*')) {
    if (
      (element.parentElement && preserved.has(element.parentElement)) ||
      (!SUPPORTED_TAGS.has(element.tagName) && !element.matches('aside[data-block-id],aside.notion-callout'))
    )
      preserved.add(element)
  }
  const replace = (element: Element, tag: string): HTMLElement => {
    const replacement = document.createElement(tag)
    for (const attribute of [...element.attributes]) replacement.setAttribute(attribute.name, attribute.value)
    replacement.append(...element.childNodes)
    element.replaceWith(replacement)
    return replacement
  }
  // Column widths are not representable; the cells carry the table.
  for (const element of document.querySelectorAll('colgroup,col'))
    if (!preserved.has(element)) element.remove()
  for (const element of document.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    if (preserved.has(element)) continue
    const level = Number(element.tagName.slice(1))
    const paragraph = replace(element, 'p')
    paragraph.style.fontSize ||= `${[28, 24, 20, 18, 16, 14][level - 1]}px`
    paragraph.style.fontWeight ||= 'bold'
  }
  for (const element of document.querySelectorAll('mark,code,pre,details,summary,figure,figcaption')) {
    if (preserved.has(element)) continue
    const tag = element.tagName.toLowerCase()
    const replacement = replace(element, ['mark', 'code'].includes(tag) ? 'span' : 'div')
    if (tag === 'details') replacement.removeAttribute('open')
    if (tag === 'mark') {
      replacement.style.backgroundColor ||= '#fff2cc'
      replacement.style.color ||= '#202124'
    }
    if (tag === 'code' || tag === 'pre') replacement.style.fontFamily ||= 'monospace'
    if (tag === 'pre') replacement.style.whiteSpace = 'pre-wrap'
  }
  for (const callout of document.querySelectorAll('aside[data-block-id],aside.notion-callout'))
    if (!preserved.has(callout)) replace(callout, 'blockquote')
  for (const checkbox of document.querySelectorAll('input[type="checkbox"]')) {
    if (preserved.has(checkbox)) continue
    checkbox.replaceWith(document.createTextNode(checkbox.hasAttribute('checked') ? '☑ ' : '☐ '))
  }
  for (const element of document.querySelectorAll('[role="checkbox"]')) {
    if (preserved.has(element)) continue
    element.prepend(document.createTextNode(element.getAttribute('aria-checked') === 'true' ? '☑ ' : '☐ '))
    element.removeAttribute('role')
    element.removeAttribute('aria-checked')
  }
  for (const element of document.querySelectorAll('hr')) {
    if (preserved.has(element)) continue
    const paragraph = replace(element, 'p')
    paragraph.textContent = '—'
  }
  for (const element of document.querySelectorAll('iframe[src],video[src],audio[src]')) {
    if (preserved.has(element)) continue
    const link = document.createElement('a')
    link.href = element.getAttribute('src') ?? ''
    link.textContent = element.getAttribute('title') || 'Embedded content'
    element.replaceWith(link)
  }
  // Docs wraps the entire fragment in a normal-weight B element.
  for (const element of document.querySelectorAll('b[id^="docs-internal-guid-"]')) {
    if (!preserved.has(element)) replace(element, 'span')
  }
  for (const element of document.querySelectorAll<HTMLElement>('*')) {
    if (preserved.has(element) || !EDITABLE_TAGS.has(element.tagName)) continue
    for (const attribute of [...element.attributes]) {
      if (INERT_ATTRIBUTES.has(attribute.name) || attribute.name.startsWith('aria-')) {
        element.removeAttribute(attribute.name)
      }
    }
    const declarations: string[] = []
    for (const { property, value, raw } of cssDeclarations(element.getAttribute('style') ?? '')) {
      if (INERT_PROPERTIES.has(property)) continue
      if (property === 'font') declarations.push(...(expandFont(document, value) ?? []))
      else if (property === 'text-decoration-line') declarations.push(`text-decoration: ${value}`)
      else declarations.push(raw)
    }
    if (declarations.length) element.setAttribute('style', declarations.join('; '))
    else element.removeAttribute('style')
  }
  return document.body.innerHTML
}
