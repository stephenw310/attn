// Deterministic RFC 5322 / MIME serialization for the outbox.
// This module deliberately has no mail-provider dependency: T16 supplies the
// durable Message-ID and sends the returned bytes through the outbox chokepoint.

import { createHash } from 'node:crypto'
import type { MailAddress } from '../../shared/mail'

const CRLF = '\r\n'
const RECOMMENDED_HEADER_WIDTH = 78
const ENCODED_WORD_MAX_BYTES = 45

export interface MimeAttachment {
  filename: string
  mimeType: string
  content: Uint8Array
  contentId?: string
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

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, ' ').trim()
}

function normalizeBodyNewlines(value: string): string {
  return value.replace(/\r\n?|\n/g, CRLF)
}

function base64Lines(value: Uint8Array | string): string {
  const encoded = Buffer.from(value).toString('base64')
  return encoded.match(/.{1,76}/g)?.join(CRLF) ?? ''
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

function formatAddress(address: MailAddress): string {
  const email = singleLine(address.email).replace(/[<>]/g, '')
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

function deterministicBoundary(kind: 'alternative' | 'mixed', rfcMessageId: string): string {
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
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(clean) ? clean : 'application/octet-stream'
}

function asciiFilenameFallback(filename: string): string {
  const fallback = singleLine(filename)
    .replace(/[^\x20-\x7e]/g, '_')
    .replace(/[\\/]/g, '_')
  return fallback || 'attachment'
}

function rfc2231Value(value: string): string {
  return [...Buffer.from(value)]
    .map((byte) => {
      const character = String.fromCharCode(byte)
      return /^[A-Za-z0-9!#$&+.^_`|~-]$/.test(character)
        ? character
        : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`
    })
    .join('')
}

function attachmentPart(attachment: MimeAttachment): string[] {
  const filename = singleLine(attachment.filename) || 'attachment'
  const fallback = asciiFilenameFallback(filename)
  const nonAscii = /[^\x20-\x7e]/.test(filename)
  const disposition = nonAscii
    ? `attachment; filename=${quoteHeaderValue(fallback)}; filename*=UTF-8''${rfc2231Value(filename)}`
    : `attachment; filename=${quoteHeaderValue(fallback)}`
  const contentType = nonAscii
    ? `${safeMimeType(attachment.mimeType)}; name=${quoteHeaderValue(fallback)}; name*=UTF-8''${rfc2231Value(filename)}`
    : `${safeMimeType(attachment.mimeType)}; name=${quoteHeaderValue(fallback)}`
  const contentId = attachment.contentId ? singleLine(attachment.contentId).replace(/^<|>$/g, '') : ''

  return [
    ...foldHeader('Content-Type', contentType),
    'Content-Transfer-Encoding: base64',
    ...foldHeader('Content-Disposition', disposition),
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
  const escaped = value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/\r\n?|\n/g, '<br>')
  return `<div>${escaped}</div>`
}

/** Build a complete CRLF-delimited message suitable for Gmail's raw MIME field. */
export function buildMime(draft: MimeDraft, options: BuildMimeOptions): string {
  if (Number.isNaN(options.date.getTime())) throw new Error('MIME date must be valid')

  const messageId = singleLine(options.rfcMessageId)
  if (!messageId) throw new Error('MIME Message-ID is required')

  const alternativeBoundary = deterministicBoundary('alternative', messageId)
  const mixedBoundary = deterministicBoundary('mixed', messageId)
  const attachments = draft.attachments ?? []
  const text = combinedBody(draft.bodyText, draft.quoteText, '\n\n')
  const authoredHtml = draft.bodyHtml.trim() ? draft.bodyHtml : plainTextHtml(draft.bodyText)
  const html = combinedBody(authoredHtml, draft.quoteHtml, '\n')
  const headers = [
    ...foldHeader('From', formatAddress({ name: '', email: options.accountEmail })),
    ...addressHeader('To', draft.to),
    ...addressHeader('Cc', draft.cc ?? []),
    ...addressHeader('Bcc', draft.bcc ?? []),
    ...foldHeader('Subject', encodeSubject(draft.subject)),
    ...foldHeader('Message-ID', messageId),
    ...(draft.inReplyTo ? foldHeader('In-Reply-To', singleLine(draft.inReplyTo)) : []),
    ...(draft.references?.length
      ? foldHeader('References', draft.references.map(singleLine).filter(Boolean).join(' '))
      : []),
    ...foldHeader('Date', options.date.toUTCString()),
    'MIME-Version: 1.0'
  ]

  if (attachments.length === 0) {
    return [
      ...headers,
      `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
      '',
      ...alternativeParts(alternativeBoundary, text, html),
      ''
    ].join(CRLF)
  }

  const mixedParts: string[] = [
    `--${mixedBoundary}`,
    `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
    '',
    ...alternativeParts(alternativeBoundary, text, html)
  ]
  for (const attachment of attachments) {
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
