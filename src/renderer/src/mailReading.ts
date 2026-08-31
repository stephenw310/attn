import DOMPurify from 'dompurify'
import { sanitizeMailHtml } from '../../shared/mailSanitizer'
import { findHtmlTrimStart, hasRenderableContentBefore } from './mailHtmlTrim'
import { type MailPresentation, mailPresentationForHtml } from './mailSurface'

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
