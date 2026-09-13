import { cssDeclarations } from '../../../shared/css'
import { snapshotClipboardStyles } from './clipboardStyles'
import { COMPOSER_STYLE_PROPERTIES } from './sanitize'

function expandFont(document: Document, value: string): string[] {
  // Some CSS parsers accept stretch keywords but omit their longhand.
  // Restrict the prefix to components that we explicitly expand.
  if (
    !/^(?:(?:normal|italic|oblique|bold|bolder|lighter|[1-9]00)\s+)*\d*\.?\d+(?:px|pt|em|rem|%)\b/i.test(
      value
    )
  )
    return [`font: ${value}`]
  const expandedStyles: string[] = []
  const probe = document.createElement('span')
  probe.style.font = value
  if ([probe.style.fontVariant, probe.style.fontStretch].some((value) => value && value !== 'normal'))
    return [`font: ${value}`]
  if (!probe.style.fontSize || !probe.style.fontFamily) return [`font: ${value}`]
  for (const name of ['font-family', 'font-size', 'font-weight', 'font-style', 'line-height']) {
    const expanded = probe.style.getPropertyValue(name)
    if (expanded) expandedStyles.push(`${name}: ${expanded}`)
  }
  return expandedStyles
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
      const match = /^((?:p|span|li|ul|ol|table|tr|td|th)\.[a-z]+\d+)\s*\{([^{}]*)\}\s*/.exec(remaining)
      if (!match) return html
      const declarations: string[] = []
      let blankHeight = false
      for (const { property, value, raw } of cssDeclarations(match[2])) {
        if (value.includes('!')) return html
        if (property === 'font') {
          declarations.push(...expandFont(document, value))
        } else if (
          property === 'list-style-type' &&
          ((match[1].startsWith('ul.') && value === 'disc') ||
            (match[1].startsWith('ol.') && value === 'decimal'))
        ) {
          // UL/OL carry the list structure into the editor.
        } else if (property === 'min-height' && /^\d+(?:\.\d+)?px$/.test(value)) {
          blankHeight = true
        } else if (COMPOSER_STYLE_PROPERTIES.has(property)) {
          declarations.push(raw)
        } else return html
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
          element.children.length === 0 ||
          [...element.children].some((child) => child.tagName !== 'BR'))
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

/** Normalize new clipboard content into the editor's email-friendly vocabulary. */
export function normalizeClipboardHtml(html: string): string {
  const expanded = expandCocoaStyles(html)
  const document = new DOMParser().parseFromString(expanded, 'text/html')
  // Unknown stylesheets may carry meaningful layout; keep the preservation path.
  if (
    document.querySelector('style') ||
    /var\s*\(|:\s*(?:inherit|initial|unset|revert(?:-layer)?)\b/i.test(document.body.innerHTML)
  )
    snapshotClipboardStyles(document)
  const supportedTags = new Set(
    'P DIV SPAN B STRONG I EM U S STRIKE A UL OL LI BLOCKQUOTE TABLE THEAD TBODY TFOOT TR TD TH IMG BR FONT H1 H2 H3 H4 H5 H6 MARK CODE PRE DETAILS SUMMARY FIGURE FIGCAPTION INPUT HR IFRAME VIDEO AUDIO'.split(
      ' '
    )
  )
  const preserved = new WeakSet<Element>()
  for (const element of document.body.querySelectorAll('*')) {
    if (
      (element.parentElement && preserved.has(element.parentElement)) ||
      (!supportedTags.has(element.tagName) && !element.matches('aside[data-block-id],aside.notion-callout'))
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
  for (const element of document.querySelectorAll<HTMLElement>('*')) {
    if (preserved.has(element)) continue
    // Docs wraps the entire fragment in a normal-weight B element.
    if (element.tagName === 'B' && element.id.startsWith('docs-internal-guid-')) replace(element, 'span')
  }
  const editableTags = new Set([
    'P',
    'DIV',
    'SPAN',
    'B',
    'STRONG',
    'I',
    'EM',
    'U',
    'S',
    'STRIKE',
    'A',
    'UL',
    'OL',
    'LI',
    'BLOCKQUOTE',
    'TABLE',
    'THEAD',
    'TBODY',
    'TFOOT',
    'TR',
    'TD',
    'TH',
    'IMG',
    'BR'
  ])
  for (const element of document.querySelectorAll<HTMLElement>('*')) {
    if (preserved.has(element) || !editableTags.has(element.tagName)) continue
    for (const attribute of [...element.attributes]) {
      if (
        [
          'id',
          'data-block-id',
          'data-content-editable-leaf',
          'data-is-empty',
          'data-placeholder',
          'contenteditable',
          'spellcheck',
          'tabindex'
        ].includes(attribute.name)
      )
        element.removeAttribute(attribute.name)
    }
    const declarations: string[] = []
    for (const { property, value, raw } of cssDeclarations(element.getAttribute('style') ?? '')) {
      if (
        [
          '-webkit-text-size-adjust',
          '-webkit-user-select',
          'user-select',
          'caret-color',
          'overflow-wrap',
          'word-wrap'
        ].includes(property)
      )
        continue
      if (property === 'font') declarations.push(...expandFont(document, value))
      else if (property === 'text-decoration-line') declarations.push(`text-decoration: ${value}`)
      else declarations.push(raw)
    }
    if (declarations.length) element.setAttribute('style', declarations.join('; '))
    else element.removeAttribute('style')
  }
  return document.body.innerHTML
}
