// Pure reply/reply-all/forward planning over the locally cached conversation.

import type { Conversation, ConversationMsg, MailAddress } from '../../shared/mail'
import { sanitizeQuoteHtml } from './quoteSanitizer'
import { escapeHtml, singleLine } from './text'

export { sanitizeQuoteHtml } from './quoteSanitizer'

export type ReplyKind = 'reply' | 'replyAll' | 'forward'

export interface ReplyPlan {
  to: MailAddress[]
  cc: MailAddress[]
  subject: string
  quoteHtml: string
  quoteText: string
  inReplyTo: string | null
  references: string[]
  sourceMessageId: string
  /** For Gmail's threadId hint. Gmail's own composer attempts to retain forwards too. */
  threadId: string
}

const REFERENCES_HEADER_MAX_BYTES = 998

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

function latestMessage(messages: readonly ConversationMsg[]): ConversationMsg {
  if (messages.length === 0) throw new Error('Cannot plan a reply for an empty conversation')
  return messages.reduce((latest, message) => (message.at >= latest.at ? message : latest))
}

function latestReplyMessage(messages: readonly ConversationMsg[], accountEmail: string): ConversationMsg {
  const latest = latestMessage(messages)
  const self = accountEmail.trim().toLowerCase()
  const nonSelf = messages.filter((message) => message.fromEmail.trim().toLowerCase() !== self)
  return nonSelf.length > 0 ? latestMessage(nonSelf) : latest
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
  // `gmail_quote` is what Gmail itself wraps a forward in, and it renders the
  // same for a recipient. Attn needs it because a forward's own markup carries
  // nothing to recognise: without the container, a draft that round-trips
  // through Gmail comes back with its forwarded message merged into the body.
  return {
    quoteHtml: `<div class="gmail_quote"><div>${htmlLines}</div><br><div>${bodyHtmlForQuote(source)}</div></div>`,
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
  const source =
    kind === 'forward'
      ? latestMessage(conversation.messages)
      : latestReplyMessage(conversation.messages, accountEmail)
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
      sourceMessageId: source.id,
      threadId: conversation.threadId
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
    sourceMessageId: source.id,
    threadId: conversation.threadId
  }
}
