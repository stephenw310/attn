/**
 * Where a message stops being the sender's new words and becomes quoted
 * history or a signature — one concern, in plain text and in HTML, plus the
 * reading split those boundaries feed (review R8). It used to live in three
 * files that shared `findSignatureLineIndex` across module boundaries.
 */
import DOMPurify from 'dompurify'
import { sanitizeMailHtml } from '../../shared/mailSanitizer'
import { type MailPresentation, mailPresentationForHtml } from './mailSurface'

const QUOTED_REPLY = /^On .{0,200} wrote:\s*$/gm
const MOBILE_SIGNATURE = /(?:^|\n)Sent from my (?:iPhone|iPad|Android|Galaxy[^\n]*)\s*$/im
const RFC_SIGNATURE = /(?:^|\n)--[ \t]*(?=\n|$)/m
const DECORATED_TEAM_SIGNATURE =
  /(?:^|\n)[ \t]*--[ \t]+[^\n]{0,116}\b(?:team|staff|support|customer (?:care|service))\b[^\n]{0,116}?[ \t]+--[ \t]*(?=\n|$)/im

function matchIndex(text: string, pattern: RegExp): number | null {
  pattern.lastIndex = 0
  return pattern.exec(text)?.index ?? null
}

/** Find a conventional signature line, including `-- The Example Team --`. */
export function findSignatureLineIndex(text: string): number | null {
  const matches = [RFC_SIGNATURE, DECORATED_TEAM_SIGNATURE, MOBILE_SIGNATURE]
    .map((pattern) => matchIndex(text, pattern))
    .filter((index): index is number => index !== null)
  return matches.length > 0 ? Math.min(...matches) : null
}

function trailingQuoteIndex(text: string): number | null {
  let lineEnd = text.endsWith('\n') && !text.endsWith('\n\n') ? text.length - 1 : text.length
  let quoteStart = -1

  while (lineEnd > 0) {
    const newline = text.lastIndexOf('\n', lineEnd - 1)
    const lineStart = newline + 1
    if (!text.startsWith('>', lineStart)) break
    quoteStart = lineStart
    lineEnd = newline
  }

  if (quoteStart < 0) return null
  return quoteStart > 0 && text[quoteStart - 1] === '\n' ? quoteStart - 1 : quoteStart
}

export function findTrimIndex(text: string): number | null {
  const candidates: number[] = []
  const signature = findSignatureLineIndex(text)
  if (signature !== null) candidates.push(signature)

  const trailingQuote = trailingQuoteIndex(text)
  if (trailingQuote !== null) candidates.push(trailingQuote)

  for (const pattern of [QUOTED_REPLY]) {
    pattern.lastIndex = 0
    const match = pattern.exec(text)
    if (match) candidates.push(match.index)
  }

  const trimIndex = candidates.length > 0 ? Math.min(...candidates) : -1
  if (trimIndex < 0 || text.slice(0, trimIndex).trim().length === 0) return null
  return trimIndex
}

const MEANINGFUL_ELEMENTS = 'img, picture, svg, table, hr, video, audio, canvas'
const TRIM_SELECTOR = '.gmail_quote, .gmail_signature_prefix, .gmail_signature, blockquote[type="cite"]'
// Contexts where a lone `--` line is content or layout rather than a signature
// separator: verbatim text (`pre`, `code`) and table cells, where a dashed
// divider or a literal em-dash cell would otherwise collapse the rest of the
// mail behind the trim control.
const TRIM_EXEMPT_ANCESTORS = `${TRIM_SELECTOR}, a, style, title, pre, code, td, th`

export function hasRenderableContent(content: DocumentFragment): boolean {
  const visibleProbe = content.cloneNode(true) as DocumentFragment
  visibleProbe.querySelectorAll('style').forEach((style) => {
    style.remove()
  })
  return Boolean(visibleProbe.textContent?.trim()) || Boolean(visibleProbe.querySelector(MEANINGFUL_ELEMENTS))
}

export function hasRenderableContentBefore(content: DocumentFragment, boundary: Node): boolean {
  const range = document.createRange()
  range.setStart(content, 0)
  range.setEndBefore(boundary)
  return hasRenderableContent(range.cloneContents())
}

function wholeLineSignatureContainer(text: Text): Node {
  if (text.data.includes('\n')) return text
  let boundary: Node = text
  let parent = text.parentElement
  while (parent && parent.textContent === text.data) {
    boundary = parent
    parent = parent.parentElement
  }
  return boundary
}

export function findHtmlTrimStart(content: DocumentFragment): Node | null {
  const walker = document.createTreeWalker(content, 5)
  let current = walker.nextNode()
  while (current) {
    if (current instanceof Element && current.matches(TRIM_SELECTOR)) return current
    if (current instanceof Text && !current.parentElement?.closest(TRIM_EXEMPT_ANCESTORS)) {
      const signatureIndex = findSignatureLineIndex(current.data)
      if (signatureIndex !== null) {
        return signatureIndex === 0 ? wholeLineSignatureContainer(current) : current.splitText(signatureIndex)
      }
    }
    current = walker.nextNode()
  }
  return null
}

export interface MailReadingParts {
  authoredHtml: string
  authoredText: string
  quoteHtml: string
  quoteText: string
  quotePresentation: MailPresentation
}

interface MailReading {
  presentation: MailPresentation
  parts?: MailReadingParts
}

const INHERITED_TEXT_STYLE =
  /^(font(?:-.+)?|color|line-height|text-align|text-transform|white-space|word-break|overflow-wrap|letter-spacing|word-spacing|direction|(?:-webkit-)?text-size-adjust)$/

function serialize(content: DocumentFragment): string {
  const template = document.createElement('template')
  template.content.append(content)
  return template.innerHTML
}

function fallbackText(content: DocumentFragment): string {
  const copy = content.cloneNode(true) as DocumentFragment
  copy.querySelectorAll('style, title').forEach((element) => {
    element.remove()
  })
  copy.querySelectorAll('br').forEach((element) => {
    element.replaceWith('\n')
  })
  copy.querySelectorAll('p, div, tr, li, h1, h2, h3, h4, h5, h6, blockquote').forEach((element) => {
    element.append('\n')
  })
  copy.querySelectorAll('td, th').forEach((element) => {
    element.append('\t')
  })
  return (copy.textContent ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** A simple reply should not inherit a light canvas from its collapsed history. */
export function mailReadingForHtml(html: string | null): MailReading {
  const presentation = mailPresentationForHtml(html)
  if (!html || presentation.surface === 'native') return { presentation }

  const template = document.createElement('template')
  template.innerHTML = sanitizeMailHtml(DOMPurify, html)
  // Selectors can depend on siblings/ancestors across the split. Keep those
  // documents intact rather than change the sender's stylesheet semantics.
  if (template.content.querySelector('style')) return { presentation }
  const boundary = findHtmlTrimStart(template.content)
  if (!boundary || !hasRenderableContentBefore(template.content, boundary)) return { presentation }
  // Only duplicate ordinary block wrappers with inherited text styles. Splitting
  // tables/lists or a wrapper's padding, fixed height, or flex layout changes it.
  for (let parent = boundary.parentElement; parent; parent = parent.parentElement) {
    if (parent.tagName !== 'DIV') return { presentation }
    for (const property of Array.from(parent.style)) {
      if (property === 'display' && parent.style.display === 'block') continue
      if (!INHERITED_TEXT_STYLE.test(property)) return { presentation }
    }
  }

  const authoredRange = document.createRange()
  authoredRange.setStart(template.content, 0)
  authoredRange.setEndBefore(boundary)
  const quoteRange = document.createRange()
  quoteRange.setStartBefore(boundary)
  quoteRange.setEnd(template.content, template.content.childNodes.length)
  const authored = authoredRange.cloneContents()
  const quote = quoteRange.cloneContents()
  const authoredText = fallbackText(authored)
  const quoteText = fallbackText(quote)
  const authoredHtml = serialize(authored)
  const quoteHtml = serialize(quote)
  const authoredPresentation = mailPresentationForHtml(authoredHtml)
  const quotePresentation = mailPresentationForHtml(quoteHtml)
  if (authoredPresentation.surface !== 'native' || quotePresentation.surface !== 'light') {
    return { presentation }
  }
  return {
    presentation: authoredPresentation,
    parts: { authoredHtml, authoredText, quoteHtml, quoteText, quotePresentation }
  }
}
