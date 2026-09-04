// Deterministic RFC 5322 / MIME serialization for the outbox.
// This module deliberately has no mail-provider dependency: T16 supplies the
// durable Message-ID and sends the returned bytes through the outbox chokepoint.

import { createHash } from 'node:crypto'
import { domainToASCII } from 'node:url'
import type { MailAddress } from '../../shared/mail'
import { combinedBody, escapeHtml, singleLine } from './text'

const CRLF = '\r\n'
const RECOMMENDED_HEADER_WIDTH = 78
const ENCODED_WORD_MAX_BYTES = 45
const RFC2231_SEGMENT_WIDTH = 45
const MAX_FILENAME_FALLBACK_LENGTH = 40
const MAX_FILENAME_LENGTH = 200
// Past this an unencoded token cannot be folded under RFC 5322's 998-octet
// hard line limit, so it goes out as foldable encoded words instead.
const MAX_UNENCODED_HEADER_BYTES = 900

export interface MimeAttachment {
  filename: string
  mimeType: string
  content: Uint8Array
  contentId?: string
  inline?: boolean
}

export interface MimeStreamAttachment {
  filename: string
  mimeType: string
  sizeBytes: number
  open: () => AsyncIterable<Uint8Array>
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
  accountName?: string
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

function needsEncodedWords(clean: string): boolean {
  return /[^\x20-\x7e]/.test(clean) || Buffer.byteLength(clean) > MAX_UNENCODED_HEADER_BYTES
}

export function encodeSubject(subject: string): string {
  const clean = singleLine(subject)
  return needsEncodedWords(clean) ? encodedWords(clean) : clean
}

function quoteHeaderValue(value: string): string {
  return `"${singleLine(value).replace(/(["\\])/g, '\\$1')}"`
}

function formatDisplayName(name: string): string {
  const clean = singleLine(name)
  if (needsEncodedWords(clean)) return encodedWords(clean)
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

/**
 * A draft checkpoint mirrors whatever the user has typed so far, so it may
 * not hold a valid addr-spec yet. Only the send path — the one boundary that
 * must never emit a malformed envelope — validates.
 */
function addrSpec(email: string, validate: boolean): string {
  return validate ? validAddrSpec(email) : singleLine(email).replace(/[<>,]/g, '')
}

function formatAddress(address: MailAddress, validate: boolean): string {
  const email = addrSpec(address.email, validate)
  const name = singleLine(address.name)
  return name ? `${formatDisplayName(name)} <${email}>` : email
}

export function foldHeader(name: string, rawValue: string): string[] {
  let value = singleLine(rawValue)
  const lines: string[] = []
  let prefix = `${name}: `

  while (prefix.length + value.length > RECOMMENDED_HEADER_WIDTH) {
    const room = RECOMMENDED_HEADER_WIDTH - prefix.length
    // A long addr-spec, parameter, or encoded word must never be split
    // internally, so when none fits the recommended width the fold moves to
    // the first boundary past it — one over-long token is far better than a
    // header of them, which RFC 5322's 998-octet hard limit would reject.
    let splitAt = value.lastIndexOf(' ', room)
    if (splitAt <= 0) splitAt = value.indexOf(' ')
    if (splitAt <= 0) break
    lines.push(prefix + value.slice(0, splitAt))
    value = value.slice(splitAt + 1)
    prefix = ' '
  }

  lines.push(prefix + value)
  return lines
}

export function addressHeader(name: string, addresses: readonly MailAddress[], validate = true): string[] {
  return addresses.length > 0
    ? foldHeader(name, addresses.map((address) => formatAddress(address, validate)).join(', '))
    : []
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
    base64Lines(body)
  ]
}

function safeMimeType(value: string): string {
  const clean = singleLine(value).toLowerCase()
  return clean.length <= 60 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(clean)
    ? clean
    : 'application/octet-stream'
}

export function asciiFilenameFallback(filename: string): string {
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

interface AttachmentSegment<T> {
  attachment: T
}

export type MimeSegment<T> = string | AttachmentSegment<T>

/**
 * The only filename either encoder emits, and therefore the only one Gmail can
 * echo back. Identity comparisons against a remote draft run through this;
 * because both encoders now carry the full name in an RFC 2231 continuation,
 * it keeps non-ASCII characters instead of folding them away. Idempotent, so
 * applying it to an already-echoed name is safe.
 */
export function mimeFilename(value: string): string {
  return singleLine(value).slice(0, MAX_FILENAME_LENGTH) || 'attachment'
}

function attachmentPart<T extends AttachmentIdentity>(attachment: T): MimeSegment<T>[] {
  const filename = mimeFilename(attachment.filename)
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
    { attachment }
  ]
}

/** Every attachment shape the encoders share, whatever supplies its bytes. */
export interface AttachmentIdentity {
  filename: string
  mimeType: string
  contentId?: string
  inline?: boolean
}

export interface MimeEntity<T extends AttachmentIdentity> {
  /** Fully formatted header lines, without MIME-Version. */
  headers: readonly string[]
  text: string
  html: string
  attachments: readonly T[]
  boundary: (kind: 'alternative' | 'related' | 'mixed') => string
  /**
   * Send normalizes body newlines to CRLF as RFC 5322 requires. A draft
   * checkpoint deliberately does not: its bytes round-trip through Gmail and
   * back into the content fingerprint, so rewriting them would make every
   * multi-line mirrored draft read as remotely changed.
   */
  normalizeNewlines: boolean
}

/**
 * The one multipart layout, shared by the send and draft encoders so a
 * message's structure cannot depend on which of them wrote it.
 */
export function mimeSegments<T extends AttachmentIdentity>(entity: MimeEntity<T>): MimeSegment<T>[] {
  const alternativeBoundary = entity.boundary('alternative')
  const relatedBoundary = entity.boundary('related')
  const mixedBoundary = entity.boundary('mixed')
  const inlineAttachments = entity.attachments.filter((attachment) => attachment.inline)
  const regularAttachments = entity.attachments.filter((attachment) => !attachment.inline)
  const body = (value: string): string => (entity.normalizeNewlines ? normalizeBodyNewlines(value) : value)
  const headers = [...entity.headers, 'MIME-Version: 1.0']

  const alternativeEntity: MimeSegment<T>[] = [
    `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
    '',
    `--${alternativeBoundary}`,
    ...textPart('text/plain', body(entity.text)),
    `--${alternativeBoundary}`,
    ...textPart('text/html', body(entity.html)),
    `--${alternativeBoundary}--`
  ]
  const bodyEntity: MimeSegment<T>[] =
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

  if (regularAttachments.length === 0) return [...headers, ...bodyEntity, '']
  return [
    ...headers,
    `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
    '',
    `--${mixedBoundary}`,
    ...bodyEntity,
    ...regularAttachments.flatMap((attachment) => [`--${mixedBoundary}`, ...attachmentPart(attachment)]),
    `--${mixedBoundary}--`,
    // The trailing empty segment is what gives the message its final CRLF.
    ''
  ]
}

function plainTextHtml(value: string): string {
  if (!value) return ''
  const escaped = escapeHtml(value).replace(/\r\n?|\n/g, '<br>')
  return `<div>${escaped}</div>`
}

function rfc5322Date(date: Date): string {
  return date.toUTCString().replace(/GMT$/, '+0000')
}

function buildMimeSegments<T extends AttachmentIdentity>(
  draft: Omit<MimeDraft, 'attachments'> & { attachments?: readonly T[] },
  options: BuildMimeOptions
): MimeSegment<T>[] {
  if (Number.isNaN(options.date.getTime())) throw new Error('MIME date must be valid')

  const messageId = singleLine(options.rfcMessageId)
  if (!messageId) throw new Error('MIME Message-ID is required')

  validateMimeRecipients(draft, options.accountEmail)
  const authoredHtml = draft.bodyHtml.trim() ? draft.bodyHtml : plainTextHtml(draft.bodyText)
  return mimeSegments({
    headers: [
      ...foldHeader(
        'From',
        formatAddress({ name: options.accountName ?? '', email: options.accountEmail }, true)
      ),
      ...addressHeader('To', draft.to),
      ...addressHeader('Cc', draft.cc ?? []),
      ...addressHeader('Bcc', draft.bcc ?? []),
      ...foldHeader('Subject', encodeSubject(draft.subject)),
      ...foldHeader('Message-ID', messageId),
      ...(draft.inReplyTo ? foldHeader('In-Reply-To', singleLine(draft.inReplyTo)) : []),
      ...(draft.references?.length
        ? foldHeader('References', draft.references.map(singleLine).filter(Boolean).join(' '))
        : []),
      ...foldHeader('Date', rfc5322Date(options.date))
    ],
    text: combinedBody(draft.bodyText, draft.quoteText, '\n\n'),
    html: combinedBody(authoredHtml, draft.quoteHtml, '\n'),
    attachments: draft.attachments ?? [],
    boundary: (kind) => deterministicBoundary(kind, messageId),
    normalizeNewlines: true
  })
}

export function isAttachmentSegment<T>(segment: MimeSegment<T>): segment is AttachmentSegment<T> {
  return typeof segment !== 'string'
}

/** Serialize buffered segments into the complete CRLF-delimited message. */
export function joinMimeSegments<T extends { content: Uint8Array }>(
  segments: readonly MimeSegment<T>[]
): string {
  return segments
    .map((segment) => (isAttachmentSegment(segment) ? base64Lines(segment.attachment.content) : segment))
    .join(CRLF)
}

/** Build a complete CRLF-delimited message suitable for Gmail's raw MIME field. */
export function buildMime(draft: MimeDraft, options: BuildMimeOptions): string {
  return joinMimeSegments(buildMimeSegments(draft, options))
}

async function* base64Stream(source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  let carry = Buffer.alloc(0)
  let firstLine = true
  for await (const value of source) {
    const chunk = Buffer.from(value)
    const data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk
    const completeLength = data.length - (data.length % 57)
    if (completeLength > 0) {
      const encoded = data
        .subarray(0, completeLength)
        .toString('base64')
        .replace(/(.{76})(?=.)/g, `$1${CRLF}`)
      yield Buffer.from(`${firstLine ? '' : CRLF}${encoded}`)
      firstLine = false
    }
    carry = data.subarray(completeLength)
  }
  if (carry.length > 0) {
    yield Buffer.from(`${firstLine ? '' : CRLF}${carry.toString('base64')}`)
  }
}

function streamedBase64ByteLength(sizeBytes: number): number {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error('MIME attachment size must be a non-negative safe integer')
  }
  const encodedBytes = 4 * Math.ceil(sizeBytes / 3)
  if (encodedBytes === 0) return 0
  return encodedBytes + (Math.ceil(encodedBytes / 76) - 1) * Buffer.byteLength(CRLF)
}

/** Exact byte count for the streamed serialization of already-built segments. */
export function mimeSegmentsByteLength<T extends { sizeBytes: number }>(
  segments: readonly MimeSegment<T>[]
): number {
  return segments.reduce(
    (total, segment, index) =>
      total +
      (isAttachmentSegment(segment)
        ? streamedBase64ByteLength(segment.attachment.sizeBytes)
        : Buffer.byteLength(segment)) +
      (index < segments.length - 1 ? Buffer.byteLength(CRLF) : 0),
    0
  )
}

/** The same bytes {@link joinMimeSegments} would produce, without buffering attachments. */
export async function* streamMimeSegments<
  T extends { sizeBytes: number; open: () => AsyncIterable<Uint8Array> }
>(
  segments: readonly MimeSegment<T>[],
  onAttachmentComplete: (attachment: T, index: number) => void = () => {}
): AsyncIterable<Uint8Array> {
  let attachmentIndex = 0
  for (const [index, segment] of segments.entries()) {
    if (isAttachmentSegment(segment)) {
      yield* base64Stream(segment.attachment.open())
      onAttachmentComplete(segment.attachment, attachmentIndex++)
    } else if (segment) {
      yield Buffer.from(segment)
    }
    if (index < segments.length - 1) yield Buffer.from(CRLF)
  }
}

/** Exact byte count for streamMime, used to make Gmail's multipart request replayable and sized. */
export function mimeByteLength(
  draft: Omit<MimeDraft, 'attachments'> & { attachments?: readonly MimeStreamAttachment[] },
  options: BuildMimeOptions
): number {
  return mimeSegmentsByteLength(buildMimeSegments(draft, options))
}

/** Stream the same deterministic MIME bytes without buffering attachment files in memory. */
export function streamMime(
  draft: Omit<MimeDraft, 'attachments'> & { attachments?: readonly MimeStreamAttachment[] },
  options: BuildMimeOptions,
  onAttachmentComplete: (attachment: MimeStreamAttachment, index: number) => void = () => {}
): AsyncIterable<Uint8Array> {
  return streamMimeSegments(buildMimeSegments(draft, options), onAttachmentComplete)
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
