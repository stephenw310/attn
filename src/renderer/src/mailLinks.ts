export interface MailTextPart {
  text: string
  href?: string
}

const BARE_URL = /(?:https?:\/\/|www\.)[^\s<>"'`]+/gi
const SENTENCE_PUNCTUATION = /[.,;:!?]/
const CLOSING_PAIR: Readonly<Record<string, string>> = {
  ')': '(',
  ']': '[',
  '}': '{'
}

function occurrences(value: string, character: string): number {
  let count = 0
  for (const candidate of value) {
    if (candidate === character) count += 1
  }
  return count
}

function urlEnd(value: string): number {
  let end = value.length
  while (end > 0 && SENTENCE_PUNCTUATION.test(value[end - 1] ?? '')) end -= 1

  while (end > 0) {
    const closing = value[end - 1] ?? ''
    const opening = CLOSING_PAIR[closing]
    if (!opening) break
    const candidate = value.slice(0, end)
    if (occurrences(candidate, closing) <= occurrences(candidate, opening)) break
    end -= 1
  }
  return end
}

function linkHref(value: string): string | null {
  const candidate = value.toLowerCase().startsWith('www.') ? `https://${value}` : value
  try {
    const url = new URL(candidate)
    return url.protocol === 'http:' || url.protocol === 'https:' ? candidate : null
  } catch {
    return null
  }
}

function hasUrlBoundary(text: string, start: number): boolean {
  if (start === 0) return true
  return !/[\p{L}\p{N}@._-]/u.test(text[start - 1] ?? '')
}

/** Split display text into safe HTTP(S) links and untouched text. */
export function mailTextParts(text: string): MailTextPart[] {
  const parts: MailTextPart[] = []
  let cursor = 0
  BARE_URL.lastIndex = 0

  for (const match of text.matchAll(BARE_URL)) {
    const start = match.index
    if (!hasUrlBoundary(text, start)) continue
    const matched = match[0]
    const end = urlEnd(matched)
    const value = matched.slice(0, end)
    const href = linkHref(value)
    if (!href) continue

    if (start > cursor) parts.push({ text: text.slice(cursor, start) })
    parts.push({ text: value, href })
    cursor = start + end
  }

  if (cursor < text.length) parts.push({ text: text.slice(cursor) })
  return parts.length > 0 ? parts : [{ text }]
}

/** Linkify bare URLs in sanitized mail without touching sender-authored anchors. */
export function linkifyBareMailUrls(root: ParentNode): void {
  const textNodes: Text[] = []
  const walker = document.createTreeWalker(root, 4)
  let current = walker.nextNode()
  while (current) {
    const text = current as Text
    if (!text.parentElement?.closest('a, style, title')) textNodes.push(text)
    current = walker.nextNode()
  }

  for (const text of textNodes) {
    const parts = mailTextParts(text.data)
    if (!parts.some((part) => part.href)) continue
    const replacement = document.createDocumentFragment()
    for (const part of parts) {
      if (!part.href) {
        replacement.append(part.text)
        continue
      }
      const link = document.createElement('a')
      link.href = part.href
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.textContent = part.text
      replacement.append(link)
    }
    text.replaceWith(replacement)
  }
}
