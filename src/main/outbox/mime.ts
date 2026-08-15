// Deterministic RFC 5322 / MIME serialization for the outbox.
// This module deliberately has no mail-provider dependency: T16 supplies the
// durable Message-ID and sends the returned bytes through the outbox chokepoint.

import { createHash } from 'node:crypto'
import { domainToASCII } from 'node:url'
import type { MailAddress } from '../../shared/mail'
import { escapeHtml, singleLine } from './text'

const CRLF = '\r\n'
const RECOMMENDED_HEADER_WIDTH = 78
const ENCODED_WORD_MAX_BYTES = 45
const RFC2231_SEGMENT_WIDTH = 45
const MAX_FILENAME_FALLBACK_LENGTH = 40

export interface MimeAttachment {
  filename: string
  mimeType: string
  content: Uint8Array
  contentId?: string
  inline?: boolean
}

export interface MimeDraft {
  to: readonly MailAddress[]
  cc?: readonly MailAddress[]
  bcc?: readonly MailAddress[]
  subject: string
  bodyText: string
  bodyHtml: string
  quoteText?: string | null
  quoteHtml?: string | null
  inReplyTo?: string | null
  references?: readonly string[]
  attachments?: readonly MimeAttachment[]
}

export interface BuildMimeOptions {
  accountEmail: string
  /** Stable, caller-owned id. The outbox persists this before any send attempt. */
  rfcMessageId: string
  date: Date
}

function normalizeBodyNewlines(value: string): string {
  return value.replace(/\r\n?|\n/g, CRLF)
}

function base64Lines(value: Uint8Array | string): string {
  const encoded = Buffer.from(value).toString('base64')
  return encoded.replace(/(.{76})(?=.)/g, `$1${CRLF}`)
}

function utf8Chunks(value: string, maxBytes: number): string[] {
  const chunks: string[] = []
  let chunk = ''
  let bytes = 0
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character)
    if (chunk && bytes + characterBytes > maxBytes) {
      chunks.push(chunk)
      chunk = ''
      bytes = 0
    }
    chunk += character
    bytes += characterBytes
  }
  if (chunk || chunks.length === 0) chunks.push(chunk)
  return chunks
}

function encodedWords(value: string): string {
  return utf8Chunks(value, ENCODED_WORD_MAX_BYTES)
    .map((chunk) => `=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`)
    .join(' ')
}

function encodeSubject(subject: string): string {
  const clean = singleLine(subject)
  return /[^\x20-\x7e]/.test(clean) || Buffer.byteLength(clean) > 900 ? encodedWords(clean) : clean
}

function quoteHeaderValue(value: string): string {
  return `"${singleLine(value).replace(/(["\\])/g, '\\$1')}"`
}

function formatDisplayName(name: string): string {
  const clean = singleLine(name)
  if (/[^\x20-\x7e]/.test(clean)) return encodedWords(clean)
  if (/^[A-Za-z0-9]+(?: [A-Za-z0-9]+)*$/.test(clean)) return clean
  return quoteHeaderValue(clean)
}

function validAddrSpec(value: string): string {
  const email = singleLine(value)
  const at = email.indexOf('@')
  const local = email.slice(0, at)
  const domain = domainToASCII(email.slice(at + 1))
  const validLocal =
    local.length > 0 &&
    local.length <= 64 &&
    /^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local) &&
    !local.startsWith('.') &&
    !local.endsWith('.') &&
    !local.includes('..')
  const validDomain =
    domain.length > 0 &&
    domain.length <= 253 &&
    domain.split('.').every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/.test(label))

  if (at <= 0 || at !== email.lastIndexOf('@') || !validLocal || !validDomain) {
    throw new Error('MIME address must contain one valid addr-spec')
  }
  return `${local}@${domain}`
}

function formatAddress(address: MailAddress): string {
  const email = validAddrSpec(address.email)
  const name = singleLine(address.name)
  return name ? `${formatDisplayName(name)} <${email}>` : email
}

function foldHeader(name: string, rawValue: string): string[] {
  let value = singleLine(rawValue)
  const lines: string[] = []
  let prefix = `${name}: `

  while (prefix.length + value.length > RECOMMENDED_HEADER_WIDTH) {
    const room = RECOMMENDED_HEADER_WIDTH - prefix.length
    const splitAt = value.lastIndexOf(' ', room)
    // A long addr-spec, parameter, or token must not be split internally. RFC's
    // 998-octet hard limit is enforced by the producers of those values.
    if (splitAt <= 0) break
    lines.push(prefix + value.slice(0, splitAt))
    value = value.slice(splitAt + 1)
    prefix = ' '
  }

  lines.push(prefix + value)
  return lines
}

function addressHeader(name: string, addresses: readonly MailAddress[]): string[] {
  return addresses.length > 0 ? foldHeader(name, addresses.map(formatAddress).join(', ')) : []
}

function deterministicBoundary(kind: 'alternative' | 'mixed' | 'related', rfcMessageId: string): string {
  const digest = createHash('sha256').update(`${kind}\0${rfcMessageId}`).digest('hex').slice(0, 24)
  return `attn-${kind}-${digest}`
}

function textPart(mimeType: 'text/plain' | 'text/html', body: string): string[] {
  return [
    `Content-Type: ${mimeType}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
    '',
    base64Lines(normalizeBodyNewlines(body))
  ]
}

function alternativeParts(boundary: string, text: string, html: string): string[] {
  return [
    `--${boundary}`,
    ...textPart('text/plain', text),
    `--${boundary}`,
    ...textPart('text/html', html),
    `--${boundary}--`
  ]
}

function safeMimeType(value: string): string {
  const clean = singleLine(value).toLowerCase()
  return clean.length <= 60 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(clean)
    ? clean
    : 'application/octet-stream'
}

function asciiFilenameFallback(filename: string): string {
  const fallback = singleLine(filename)
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/[\\/]/g, '_')
  if (!fallback) return 'attachment'
  if (fallback.length <= MAX_FILENAME_FALLBACK_LENGTH) return fallback

  const extension = fallback.slice(fallback.lastIndexOf('.'))
  return extension.length > 1 && extension.length < MAX_FILENAME_FALLBACK_LENGTH
    ? `${fallback.slice(0, MAX_FILENAME_FALLBACK_LENGTH - extension.length)}${extension}`
    : fallback.slice(0, MAX_FILENAME_FALLBACK_LENGTH)
}

function rfc2231Atoms(value: string): string[] {
  return [...Buffer.from(value)].map((byte) => {
    const character = String.fromCharCode(byte)
    return /^[A-Za-z0-9!#$&+.^_`|~-]$/.test(character)
      ? character
      : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
  })
}

function rfc2231Parameters(name: string, value: string): string[] {
  const chunks: string[] = []
  let chunk = ''
  for (const atom of rfc2231Atoms(value)) {
    if (chunk && chunk.length + atom.length > RFC2231_SEGMENT_WIDTH) {
      chunks.push(chunk)
      chunk = ''
    }
    chunk += atom
  }
  if (chunk || chunks.length === 0) chunks.push(chunk)

  if (chunks.length === 1) return [`${name}*=UTF-8''${chunks[0]}`]
  return chunks.map((part, index) => `${name}*${index}*=${index === 0 ? "UTF-8''" : ''}${part}`)
}

function parameterizedHeader(name: string, value: string, parameters: readonly string[]): string[] {
  const lines: string[] = []
  let line = `${name}: ${value}`
  for (const [index, parameter] of parameters.entries()) {
    const appended = `${line}; ${parameter}`
    const trailingSemicolonWidth = index < parameters.length - 1 ? 1 : 0
    if (appended.length + trailingSemicolonWidth <= RECOMMENDED_HEADER_WIDTH) {
      line = appended
      continue
    }
    lines.push(`${line};`)
    line = ` ${parameter}`
  }
  lines.push(line)
  return lines
}

function filenameParameters(name: string, filename: string): string[] {
  const fallback = asciiFilenameFallback(filename)
  const parameters = [`${name}=${quoteHeaderValue(fallback)}`]
  if (/[^\x20-\x7e]/.test(filename) || filename.length > MAX_FILENAME_FALLBACK_LENGTH) {
    parameters.push(...rfc2231Parameters(name, filename))
  }
  return parameters
}

function attachmentPart(attachment: MimeAttachment): string[] {
  const filename = singleLine(attachment.filename) || 'attachment'
  const contentId = attachment.contentId ? singleLine(attachment.contentId).replace(/^<|>$/g, '') : ''

  return [
    ...parameterizedHeader(
      'Content-Type',
      safeMimeType(attachment.mimeType),
      filenameParameters('name', filename)
    ),
    'Content-Transfer-Encoding: base64',
    ...parameterizedHeader(
      'Content-Disposition',
      attachment.inline ? 'inline' : 'attachment',
      filenameParameters('filename', filename)
    ),
    ...(contentId ? [`Content-ID: <${contentId}>`] : []),
    '',
    base64Lines(attachment.content)
  ]
}

function combinedBody(primary: string, quote: string | null | undefined, separator: string): string {
  if (!quote) return primary
  if (!primary) return quote
  return `${primary}${separator}${quote}`
}

function plainTextHtml(value: string): string {
  if (!value) return ''
  const escaped = escapeHtml(value).replace(/\r\n?|\n/g, '<br>')
  return `<div>${escaped}</div>`
}

function rfc5322Date(date: Date): string {
  return date.toUTCString().replace(/GMT$/, '+0000')
}

/** Build a complete CRLF-delimited message suitable for Gmail's raw MIME field. */
export function buildMime(draft: MimeDraft, options: BuildMimeOptions): string {
  if (Number.isNaN(options.date.getTime())) throw new Error('MIME date must be valid')

  const messageId = singleLine(options.rfcMessageId)
  if (!messageId) throw new Error('MIME Message-ID is required')

  validateMimeRecipients(draft, options.accountEmail)
  const cc = draft.cc ?? []
  const bcc = draft.bcc ?? []

  const alternativeBoundary = deterministicBoundary('alternative', messageId)
  const mixedBoundary = deterministicBoundary('mixed', messageId)
  const relatedBoundary = deterministicBoundary('related', messageId)
  const attachments = draft.attachments ?? []
  const inlineAttachments = attachments.filter((attachment) => attachment.inline)
  const regularAttachments = attachments.filter((attachment) => !attachment.inline)
  const text = combinedBody(draft.bodyText, draft.quoteText, '\n\n')
  const authoredHtml = draft.bodyHtml.trim() ? draft.bodyHtml : plainTextHtml(draft.bodyText)
  const html = combinedBody(authoredHtml, draft.quoteHtml, '\n')
  const headers = [
    ...foldHeader('From', formatAddress({ name: '', email: options.accountEmail })),
    ...addressHeader('To', draft.to),
    ...addressHeader('Cc', cc),
    ...addressHeader('Bcc', bcc),
    ...foldHeader('Subject', encodeSubject(draft.subject)),
    ...foldHeader('Message-ID', messageId),
    ...(draft.inReplyTo ? foldHeader('In-Reply-To', singleLine(draft.inReplyTo)) : []),
    ...(draft.references?.length
      ? foldHeader('References', draft.references.map(singleLine).filter(Boolean).join(' '))
      : []),
    ...foldHeader('Date', rfc5322Date(options.date)),
    'MIME-Version: 1.0'
  ]

  if (inlineAttachments.length === 0 && regularAttachments.length === 0) {
    return [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
      '',
      ...alternativeParts(alternativeBoundary, text, html),
      ''
    ].join(CRLF)
  }

  const alternativeEntity = [
    `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
    '',
    ...alternativeParts(alternativeBoundary, text, html)
  ]
  const bodyEntity =
    inlineAttachments.length === 0
      ? alternativeEntity
      : [
          `Content-Type: multipart/related; boundary="${relatedBoundary}"`,
          '',
          `--${relatedBoundary}`,
          ...alternativeEntity,
          ...inlineAttachments.flatMap((attachment) => [
            `--${relatedBoundary}`,
            ...attachmentPart(attachment)
          ]),
          `--${relatedBoundary}--`
        ]

  if (regularAttachments.length === 0) {
    return [...headers, ...bodyEntity, ''].join(CRLF)
  }

  const mixedParts: string[] = [`--${mixedBoundary}`, ...bodyEntity]
  for (const attachment of regularAttachments) {
    mixedParts.push(`--${mixedBoundary}`, ...attachmentPart(attachment))
  }
  mixedParts.push(`--${mixedBoundary}--`)

  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    '',
    ...mixedParts,
    ''
  ].join(CRLF)
}

/** Validate before queue persistence; buildMime repeats this as a final boundary. */
export function validateMimeRecipients(
  draft: Pick<MimeDraft, 'to' | 'cc' | 'bcc'>,
  accountEmail: string
): void {
  validAddrSpec(accountEmail)
  const cc = draft.cc ?? []
  const bcc = draft.bcc ?? []
  const recipients = [...draft.to, ...cc, ...bcc]
  if (recipients.length === 0) throw new Error('MIME message requires at least one recipient')
  for (const address of recipients) validAddrSpec(address.email)
}
