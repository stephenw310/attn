// Pure reply/reply-all/forward planning over the locally cached conversation.

import type { Conversation, ConversationMsg, MailAddress } from '../../shared/mail'

export type ReplyKind = 'reply' | 'replyAll' | 'forward'

export interface ReplyPlan {
  to: MailAddress[]
  cc: MailAddress[]
  subject: string
  quoteHtml: string
  quoteText: string
  inReplyTo: string | null
  references: string[]
  /** For Gmail's threadId send hint. Forwards deliberately start a new thread. */
  threadId: string | null
}

const FORBIDDEN_QUOTE_TAGS = new Set([
  'script',
  'style',
  'iframe',
  'object',
  'embed',
  'svg',
  'math',
  'template',
  'noscript',
  'form',
  'input',
  'button',
  'select',
  'textarea',
  'video',
  'audio',
  'canvas',
  'img'
])
const ALLOWED_QUOTE_TAGS = new Set([
  'p',
  'div',
  'br',
  'b',
  'strong',
  'i',
  'em',
  'u',
  'a',
  'ul',
  'ol',
  'li',
  'blockquote'
])
const VOID_QUOTE_TAGS = new Set(['br'])
const HTML_TOKEN = /<!--[\s\S]*?-->|<![^>]*>|<[^>]*>/g
const REFERENCES_HEADER_MAX_BYTES = 998

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function escapeHtmlTextChunk(value: string): string {
  // Existing entities are safe in a text node and preserving them avoids turning
  // every quoted "&amp;" into a visible "&amp;amp;".
  return value.replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function safeLinkFromToken(token: string): string {
  const match = token.match(/\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i)
  const href = (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim()
  const hasControlCharacter = [...href].some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
  if (!/^(?:https?:|mailto:|#)/i.test(href) || hasControlCharacter) return ''
  return ` href="${href.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}"`
}

/**
 * Conservative, DOM-free quote sanitizer. It keeps the same minimal authored
 * formatting that the outgoing composer accepts, drops every other attribute,
 * and removes active/replaced-element contents before they enter a draft.
 */
export function sanitizeQuoteHtml(html: string): string {
  const output: string[] = []
  const suppressed: string[] = []
  let cursor = 0

  for (const match of html.matchAll(HTML_TOKEN)) {
    const index = match.index ?? 0
    if (suppressed.length === 0) output.push(escapeHtmlTextChunk(html.slice(cursor, index)))
    cursor = index + match[0].length

    const token = match[0]
    const tagMatch = token.match(/^<\s*(\/?)\s*([A-Za-z][A-Za-z0-9:-]*)/)
    if (!tagMatch) continue

    const closing = tagMatch[1] === '/'
    const tag = tagMatch[2].toLowerCase()
    const selfClosing = /\/\s*>$/.test(token) || VOID_QUOTE_TAGS.has(tag)

    if (FORBIDDEN_QUOTE_TAGS.has(tag)) {
      if (closing) {
        if (suppressed.at(-1) === tag) suppressed.pop()
      } else if (!selfClosing) {
        suppressed.push(tag)
      }
      continue
    }
    if (suppressed.length > 0 || !ALLOWED_QUOTE_TAGS.has(tag)) continue

    if (closing) output.push(`</${tag}>`)
    else if (tag === 'a') output.push(`<a${safeLinkFromToken(token)}>`)
    else output.push(`<${tag}>`)
  }

  if (suppressed.length === 0) output.push(escapeHtmlTextChunk(html.slice(cursor)))
  return output.join('').trim()
}

function cleanAddress(address: MailAddress): MailAddress | null {
  const email = singleLine(address.email)
  if (!email) return null
  return { name: singleLine(address.name), email }
}

function uniqueAddresses(
  addresses: readonly MailAddress[],
  excludedEmails: ReadonlySet<string> = new Set()
): MailAddress[] {
  const seen = new Set<string>()
  const result: MailAddress[] = []
  for (const candidate of addresses) {
    const address = cleanAddress(candidate)
    if (!address) continue
    const key = address.email.toLowerCase()
    if (excludedEmails.has(key) || seen.has(key)) continue
    seen.add(key)
    result.push(address)
  }
  return result
}

function latestMessage(messages: readonly ConversationMsg[], accountEmail: string): ConversationMsg {
  if (messages.length === 0) throw new Error('Cannot plan a reply for an empty conversation')
  const self = accountEmail.trim().toLowerCase()
  const nonSelf = messages.filter((message) => message.fromEmail.trim().toLowerCase() !== self)
  const candidates = nonSelf.length > 0 ? nonSelf : messages
  return candidates.reduce((latest, message) => (message.at >= latest.at ? message : latest))
}

function prefixedSubject(kind: ReplyKind, rawSubject: string): string {
  const subject = singleLine(rawSubject)
  if (kind === 'forward') return /^(?:fwd?|forward)\s*:/i.test(subject) ? subject : `Fwd: ${subject}`
  return /^(?:re|reply)\s*:/i.test(subject) ? subject : `Re: ${subject}`
}

function quoteDate(timestamp: number): string {
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? 'an unknown date' : date.toUTCString()
}

function mailboxText(address: MailAddress): string {
  const name = singleLine(address.name)
  const email = singleLine(address.email)
  return name ? `${name} <${email}>` : email
}

function bodyHtmlForQuote(source: ConversationMsg): string {
  const sanitized = source.bodyHtml ? sanitizeQuoteHtml(source.bodyHtml) : ''
  if (sanitized) return sanitized
  return escapeHtml(source.bodyText).replace(/\r\n?|\n/g, '<br>')
}

function quotedText(body: string): string {
  return body
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n')
}

function replyQuote(source: ConversationMsg): Pick<ReplyPlan, 'quoteHtml' | 'quoteText'> {
  const sender = { name: source.fromName, email: source.fromEmail }
  const attribution = `On ${quoteDate(source.at)}, ${mailboxText(sender)} wrote:`
  return {
    quoteHtml: `<div>${escapeHtml(attribution)}</div><blockquote>${bodyHtmlForQuote(source)}</blockquote>`,
    quoteText: `${attribution}\n${quotedText(source.bodyText)}`
  }
}

function addressListText(addresses: readonly MailAddress[]): string {
  return addresses.map(mailboxText).join(', ')
}

function forwardQuote(source: ConversationMsg, subject: string): Pick<ReplyPlan, 'quoteHtml' | 'quoteText'> {
  const from = mailboxText({ name: source.fromName, email: source.fromEmail })
  const to = addressListText(source.recipients.to)
  const cc = addressListText(source.recipients.cc)
  const headerLines = [
    '---------- Forwarded message ---------',
    `From: ${from}`,
    `Date: ${quoteDate(source.at)}`,
    `Subject: ${singleLine(subject)}`,
    ...(to ? [`To: ${to}`] : []),
    ...(cc ? [`Cc: ${cc}`] : [])
  ]
  const htmlLines = headerLines.map((line) => escapeHtml(line)).join('<br>')
  return {
    quoteHtml: `<div>${htmlLines}</div><br><div>${bodyHtmlForQuote(source)}</div>`,
    quoteText: `${headerLines.join('\n')}\n\n${source.bodyText}`
  }
}

function replyReferences(source: ConversationMsg): { inReplyTo: string | null; references: string[] } {
  const inReplyTo = source.rfcMessageId ? singleLine(source.rfcMessageId) : null
  if (!inReplyTo) return { inReplyTo: null, references: [] }

  const references = [...source.references.map(singleLine).filter(Boolean), inReplyTo].filter(
    (value, index, values) => values.indexOf(value) === index
  )
  while (
    references.length > 0 &&
    Buffer.byteLength(`References: ${references.join(' ')}`, 'utf8') > REFERENCES_HEADER_MAX_BYTES
  ) {
    references.shift()
  }
  return { inReplyTo, references }
}

export function planReply(kind: ReplyKind, conversation: Conversation, accountEmail: string): ReplyPlan {
  const source = latestMessage(conversation.messages, accountEmail)
  const self = new Set([accountEmail.trim().toLowerCase()])
  const replyTargets =
    source.recipients.replyTo.length > 0
      ? source.recipients.replyTo
      : [{ name: source.fromName, email: source.fromEmail }]

  if (kind === 'forward') {
    const quote = forwardQuote(source, conversation.subject)
    return {
      to: [],
      cc: [],
      subject: prefixedSubject(kind, conversation.subject),
      ...quote,
      inReplyTo: null,
      references: [],
      threadId: null
    }
  }

  const to = uniqueAddresses(
    kind === 'replyAll' ? [...replyTargets, ...source.recipients.to] : replyTargets,
    self
  )
  const toEmails = new Set([...self, ...to.map((address) => address.email.toLowerCase())])
  const cc = kind === 'replyAll' ? uniqueAddresses(source.recipients.cc, toEmails) : []
  const quote = replyQuote(source)

  return {
    to,
    cc,
    subject: prefixedSubject(kind, conversation.subject),
    ...quote,
    ...replyReferences(source),
    threadId: conversation.threadId
  }
}
