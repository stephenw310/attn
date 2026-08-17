import { type DefaultTreeAdapterTypes, parseFragment } from 'parse5'

/**
 * A draft leaves Attn with its authored body and its quoted trail joined into
 * one HTML document, because that is the only shape Gmail stores. Reading it
 * back verbatim would move the trail into the editor, where a quoted newsletter
 * becomes a read-only region and an untouched reply starts to look edited.
 *
 * Recover the two columns by finding the trailing quote structurally. Gmail
 * rewrites markup, so nothing here matches bytes; it matches the shapes a quote
 * takes — a `gmail_quote` container, or the bare `blockquote` Attn writes with
 * its attribution line directly above it.
 */

const QUOTE_CONTAINER = new Set(['gmail_quote', 'gmail_quote_container'])
/** Attn writes this line itself, in English, so matching its text is exact. */
const ATTRIBUTION = /wrote:\s*$/

type Node = DefaultTreeAdapterTypes.ChildNode
type Element = DefaultTreeAdapterTypes.Element

export interface SplitQuote {
  bodyHtml: string
  quoteHtml: string
  bodyText: string
  quoteText: string
}

function isElement(node: Node): node is Element {
  return 'tagName' in node
}

function isBlank(node: Node): boolean {
  return node.nodeName === '#text' && !('value' in node && node.value.trim())
}

function classList(element: Element): string[] {
  const value = element.attrs.find((attribute) => attribute.name === 'class')?.value ?? ''
  return value.split(/\s+/)
}

function textOf(node: Node): string {
  if (node.nodeName === '#text' && 'value' in node) return node.value
  if (!('childNodes' in node)) return ''
  return node.childNodes.map(textOf).join('')
}

/** The element that starts the quoted trail, or null when there is no clean boundary. */
function findQuoteStart(children: Node[]): Node | null {
  const lastMeaningful = [...children].reverse().find((node) => !isBlank(node))
  if (!lastMeaningful || !isElement(lastMeaningful)) return null

  // Everything after the quote must be blank. Content below it means the author
  // typed there — reassembly always appends the quote last, so splitting would
  // reorder their words.
  const container = classList(lastMeaningful).some((name) => QUOTE_CONTAINER.has(name))
  if (container) return lastMeaningful
  if (lastMeaningful.tagName !== 'blockquote') return null

  // Attn's own reply shape: the attribution sits in a sibling directly above.
  const index = children.indexOf(lastMeaningful)
  const previous = [...children.slice(0, index)].reverse().find((node) => !isBlank(node))
  if (previous && isElement(previous) && ATTRIBUTION.test(textOf(previous))) return previous
  return lastMeaningful
}

function splitText(bodyText: string): { bodyText: string; quoteText: string } {
  const lines = bodyText.split('\n')
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index].trim()
    if (!ATTRIBUTION.test(line) && !line.startsWith('---------- Forwarded message')) continue
    const body = lines.slice(0, index).join('\n').trimEnd()
    return { bodyText: body, quoteText: lines.slice(index).join('\n') }
  }
  return { bodyText, quoteText: '' }
}

interface Boundary {
  bodyHtml: string
  quoteHtml: string
}

/**
 * Gmail wraps a whole draft body in a `<div dir="ltr">`, so the quote is rarely
 * a top-level sibling. Descend through single wrappers to find it, and rebuild
 * the body with those wrappers closed around it — slicing alone would leave the
 * body with unclosed tags and hand their closes to the quote.
 */
function locateQuote(
  html: string,
  children: Node[],
  contentStart: number,
  contentEnd: number,
  open: string,
  close: string
): Boundary | null {
  const offset = findQuoteStart(children)?.sourceCodeLocation?.startOffset
  if (offset !== undefined) {
    const body = html.slice(contentStart, offset).trimEnd()
    // Nothing above the quote means the author wrote nothing to separate.
    if (!body) return null
    return {
      bodyHtml: `${open}${body}${close}`,
      // To the end of the content, not the end of the element: trailing bytes
      // belong to the quote rather than being dropped.
      quoteHtml: html.slice(offset, contentEnd).trim()
    }
  }
  const meaningful = children.filter((node) => !isBlank(node))
  if (meaningful.length !== 1) return null
  const wrapper = meaningful[0]
  if (!isElement(wrapper)) return null
  const location = wrapper.sourceCodeLocation
  if (!location?.startTag || !location.endTag) return null
  return locateQuote(
    html,
    wrapper.childNodes,
    location.startTag.endOffset,
    location.endTag.startOffset,
    `${open}${html.slice(location.startOffset, location.startTag.endOffset)}`,
    `${html.slice(location.endTag.startOffset, location.endOffset)}${close}`
  )
}

/**
 * Returns the original string unchanged in `bodyHtml` when no trailing quote is
 * recognizable, which is the safe outcome: the draft keeps working exactly as
 * it did before, just without the collapsed quote.
 */
export function splitQuotedTrail(bodyHtml: string, bodyText: string): SplitQuote {
  const merged = { bodyHtml, quoteHtml: '', bodyText, quoteText: '' }
  if (!bodyHtml.trim()) return merged
  const fragment = parseFragment(bodyHtml, { sourceCodeLocationInfo: true })
  const found = locateQuote(bodyHtml, fragment.childNodes, 0, bodyHtml.length, '', '')
  if (!found) return merged
  return { ...found, ...splitText(bodyText) }
}
