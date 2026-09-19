import { type DefaultTreeAdapterTypes, parseFragment } from 'parse5'
import { isAttnSignatureLine } from '../../shared/settings'

/** Combined UTF-8 size of both body alternatives, before trimming or parsing. */
export const STYLE_EXAMPLE_MAX_INPUT_BYTES = 64 * 1024

const EXCLUDED_CLASSES = new Set([
  'gmail_quote',
  'gmail_quote_container',
  'gmail_attr',
  'gmail_signature',
  'gmail_signature_prefix',
  'yahoo_quoted',
  'moz-cite-prefix',
  'moz-signature',
  'protonmail_quote',
  'protonmail_signature',
  'protonmail_signature_block'
])
const EXCLUDED_TAGS = new Set(['blockquote', 'head', 'style', 'script', 'title', 'template'])
const BLOCK_TAGS = new Set(['div', 'p', 'li', 'tr', 'table', 'section', 'article', 'pre', 'hr'])

/** Parse without a browser or resource loader. Keep text outside marked quotes and signatures. */
function authoredHtmlText(html: string): string {
  type Node = DefaultTreeAdapterTypes.ChildNode
  const pending: Array<Node | string> = [...parseFragment(html).childNodes].reverse()
  const text: string[] = []
  while (pending.length > 0) {
    const node = pending.pop()
    if (typeof node === 'string') {
      text.push(node)
    } else if (node && 'value' in node) {
      text.push(node.value)
    } else if (node && 'tagName' in node) {
      const attrs = new Map(node.attrs.map((attr) => [attr.name, attr.value]))
      const id = attrs.get('id')?.toLowerCase()
      // Outlook's reply header marks the start of an unwrapped quoted trail.
      if (id === 'divrplyfwdmsg') break
      const classes = (attrs.get('class') ?? '').toLowerCase().split(/\s+/)
      if (
        EXCLUDED_TAGS.has(node.tagName) ||
        classes.some((name) => EXCLUDED_CLASSES.has(name)) ||
        id === 'signature' ||
        id === 'applemailsignature' ||
        attrs.has('data-attn-signature') ||
        attrs.has('hidden') ||
        attrs.get('aria-hidden') === 'true'
      ) {
        text.push('\n')
        continue
      }
      const block = BLOCK_TAGS.has(node.tagName)
      if (block || node.tagName === 'br') text.push('\n')
      if (block) pending.push('\n')
      else if (node.tagName === 'td' || node.tagName === 'th') pending.push(' ')
      for (let index = node.childNodes.length - 1; index >= 0; index--) pending.push(node.childNodes[index])
    }
  }
  return text.join('')
}

function authoredPlainText(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  const kept: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim()
    if (
      /^--\s*$/.test(line) ||
      /^--\s+.*\b(?:team|staff|support|customer (?:care|service))\b.*\s+--$/i.test(line) ||
      /^Sent from my (?:iPhone|iPad|Android|Galaxy\b.*)\s*$/i.test(line) ||
      /^Get Outlook for (?:iOS|Android)\b/i.test(line) ||
      isAttnSignatureLine(line) ||
      /^[-_]{2,}\s*(?:Original|Forwarded) Message\s*[-_]{2,}$/i.test(line) ||
      /^Begin forwarded message:\s*$/i.test(line)
    ) {
      break
    }
    // Wrapped attributions are common in text/plain alternatives. Once one
    // starts, omit the trail even when its quoted lines have no > prefix.
    if (/^On\s/i.test(line)) {
      const attribution = lines.slice(index, index + 6).join(' ')
      if (/^On\s.{1,600}?\bwrote:\s*(?:$|\s)/i.test(attribution)) break
    }
    // Outlook plain-text replies use a header block instead of "On ... wrote".
    if (/^From:\s*\S/i.test(line)) {
      const headers = lines.slice(index + 1, index + 8)
      if (
        headers.some((value) => /^\s*(?:Sent|Date):/i.test(value)) &&
        headers.some((value) => /^\s*(?:To|Subject):/i.test(value))
      )
        break
    }
    if (/^\s*>/.test(line)) continue
    kept.push(lines[index].trimEnd())
  }
  return kept
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Style examples favor excluding uncertain material over preserving every word.
 * HTML carries quote/signature boundaries lost in plain-text alternatives. Never
 * fall back to the raw text when removing those boundaries leaves no authored text.
 */
export function styleExampleText(bodyText: string | null, bodyHtml: string | null): string {
  // Check code-unit length first so a direct caller with an enormous string
  // cannot make even the byte count scan unbounded input. Oversized HTML must
  // never fall back to its plain-text alternative or be parsed as a fragment.
  if ((bodyText?.length ?? 0) + (bodyHtml?.length ?? 0) > STYLE_EXAMPLE_MAX_INPUT_BYTES) return ''
  if (Buffer.byteLength(bodyText ?? '') + Buffer.byteLength(bodyHtml ?? '') > STYLE_EXAMPLE_MAX_INPUT_BYTES) {
    return ''
  }
  return authoredPlainText(bodyHtml?.trim() ? authoredHtmlText(bodyHtml) : (bodyText ?? ''))
}
