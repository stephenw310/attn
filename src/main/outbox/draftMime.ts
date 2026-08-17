import { createHash } from 'node:crypto'
import type { MailAddress } from '../../shared/address'

/** Identity every attachment shape carries, whatever supplies its bytes. */
interface DraftMimeAttachmentIdentity {
  filename: string
  mimeType: string
  contentId?: string
  inline?: boolean
}

export interface DraftMimeAttachment extends DraftMimeAttachmentIdentity {
  content: Uint8Array
}

/** Spool-backed attachment whose bytes are read only while the request streams. */
export interface DraftMimeStreamAttachment extends DraftMimeAttachmentIdentity {
  sizeBytes: number
  open: () => AsyncIterable<Uint8Array>
}

export interface DraftMimeInput<TAttachment extends DraftMimeAttachmentIdentity = DraftMimeAttachment> {
  to: readonly MailAddress[]
  cc: readonly MailAddress[]
  bcc: readonly MailAddress[]
  subject: string
  bodyHtml: string
  bodyText: string
  quoteHtml?: string
  quoteText?: string
  inReplyTo?: string | null
  references?: readonly string[]
  attachments?: readonly TAttachment[]
}

type AttachmentSegment<T> = { attachment: T }
type DraftMimeSegment<T> = string | AttachmentSegment<T>

const CRLF = '\r\n'

const ENCODED_WORD_BYTES = 45
const RECOMMENDED_HEADER_WIDTH = 78

function cleanHeader(value: string): string {
  return value.replace(/[\r\n\0]+/g, ' ').trim()
}

function utf8Chunks(value: string): string[] {
  const chunks: string[] = []
  let chunk = ''
  let size = 0
  for (const character of value) {
    const characterSize = Buffer.byteLength(character)
    if (chunk && size + characterSize > ENCODED_WORD_BYTES) {
      chunks.push(chunk)
      chunk = ''
      size = 0
    }
    chunk += character
    size += characterSize
  }
  if (chunk) chunks.push(chunk)
  return chunks
}

function encodeHeaderText(value: string): string {
  const clean = cleanHeader(value)
  if (/^[\x20-\x7e]*$/.test(clean) && Buffer.byteLength(clean) <= 60) return clean
  return utf8Chunks(clean)
    .map((chunk) => `=?UTF-8?B?${Buffer.from(chunk).toString('base64')}?=`)
    .join(' ')
}

function formatAddress(address: MailAddress): string {
  const email = cleanHeader(address.email).replace(/[<>]/g, '')
  if (!address.name) return email
  const name = encodeHeaderText(address.name)
  const display = name.startsWith('=?UTF-8?') ? name : `"${name.replace(/["\\]/g, '\\$&')}"`
  return `${display} <${email}>`
}

function foldHeader(name: string, value: string): string {
  const lines: string[] = []
  let prefix = `${name}: `
  let remaining = value
  while (prefix.length + remaining.length > RECOMMENDED_HEADER_WIDTH) {
    let splitAt = remaining.lastIndexOf(' ', RECOMMENDED_HEADER_WIDTH - prefix.length)
    if (splitAt <= 0) splitAt = remaining.indexOf(' ')
    if (splitAt <= 0) break
    lines.push(`${prefix}${remaining.slice(0, splitAt)}`)
    remaining = remaining.slice(splitAt + 1)
    prefix = ' '
  }
  lines.push(`${prefix}${remaining}`)
  return lines.join('\r\n')
}

function addressHeader(name: string, addresses: readonly MailAddress[]): string | null {
  if (addresses.length === 0) return null
  return foldHeader(name, addresses.map(formatAddress).join(', '))
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function wrapBase64(value: string | Uint8Array): string {
  return (
    Buffer.from(value)
      .toString('base64')
      .match(/.{1,76}/g)
      ?.join('\r\n') ?? ''
  )
}

function safeMimeType(value: string): string {
  const clean = cleanHeader(value).toLowerCase()
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(clean) ? clean : 'application/octet-stream'
}

/**
 * The only filename Gmail ever sees, and therefore the only one it can echo
 * back. Identity comparisons against a remote draft must run through this or a
 * name carrying non-ASCII characters will never match the file that produced
 * it. Idempotent, so applying it to an already-echoed name is safe.
 */
export function mimeFilename(value: string): string {
  return (
    cleanHeader(value)
      .replace(/[^\x20-\x7e]/g, '_')
      .slice(0, 200) || 'inline-image'
  )
}

function quotedFilename(value: string): string {
  return `"${mimeFilename(value).replace(/["\\]/g, '\\$&')}"`
}

function boundary<T extends DraftMimeAttachmentIdentity>(
  kind: 'alternative' | 'related' | 'mixed',
  input: DraftMimeInput<T>
): string {
  const identity = [
    kind,
    input.subject,
    ...(input.attachments ?? []).map((item) => `${item.contentId ?? ''}\0${item.filename}`)
  ].join('\0')
  return `attn-draft-${kind}-${createHash('sha256').update(identity).digest('hex').slice(0, 20)}`
}

function plainTextHtml(value: string): string {
  return `<p>${escapeHtml(value).replace(/\r\n?|\n/g, '<br>')}</p>`
}

/** Canonical HTML representation used by both MIME and conflict fingerprints. */
export function draftHtmlBody(input: Pick<DraftMimeInput, 'bodyHtml' | 'bodyText' | 'quoteHtml'>): string {
  const authored = input.bodyHtml || plainTextHtml(input.bodyText)
  return input.quoteHtml ? `${authored}${authored ? '\n' : ''}${input.quoteHtml}` : authored
}

function draftTextBody(input: Pick<DraftMimeInput, 'bodyText' | 'quoteText'>): string {
  if (!input.quoteText) return input.bodyText
  return input.bodyText ? `${input.bodyText}\n\n${input.quoteText}` : input.quoteText
}

function textPart(mimeType: 'text/plain' | 'text/html', value: string): string[] {
  return [
    `Content-Type: ${mimeType}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(value)
  ]
}

function attachmentPart<T extends DraftMimeAttachmentIdentity>(attachment: T): DraftMimeSegment<T>[] {
  const contentId = cleanHeader(attachment.contentId ?? '').replace(/^<|>$/g, '')
  return [
    `Content-Type: ${safeMimeType(attachment.mimeType)}; name=${quotedFilename(attachment.filename)}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: ${attachment.inline ? 'inline' : 'attachment'}; filename=${quotedFilename(attachment.filename)}`,
    ...(contentId ? [`Content-ID: <${contentId}>`] : []),
    '',
    { attachment }
  ]
}

function isAttachmentSegment<T>(segment: DraftMimeSegment<T>): segment is AttachmentSegment<T> {
  return typeof segment !== 'string'
}

/**
 * One layout shared by the buffered and streamed encoders, so a draft's bytes
 * cannot depend on which one wrote them.
 */
function draftMimeSegments<T extends DraftMimeAttachmentIdentity>(
  input: DraftMimeInput<T>
): DraftMimeSegment<T>[] {
  const html = draftHtmlBody(input)
  const text = draftTextBody(input)
  const attachments = input.attachments ?? []
  const inlineAttachments = attachments.filter((attachment) => attachment.inline)
  const regularAttachments = attachments.filter((attachment) => !attachment.inline)
  const alternativeBoundary = boundary('alternative', input)
  const relatedBoundary = boundary('related', input)
  const mixedBoundary = boundary('mixed', input)
  const headers = [
    addressHeader('To', input.to),
    addressHeader('Cc', input.cc),
    addressHeader('Bcc', input.bcc),
    input.subject ? foldHeader('Subject', encodeHeaderText(input.subject)) : null,
    input.inReplyTo ? foldHeader('In-Reply-To', cleanHeader(input.inReplyTo)) : null,
    input.references?.length
      ? foldHeader('References', input.references.map(cleanHeader).filter(Boolean).join(' '))
      : null,
    'MIME-Version: 1.0'
  ].filter((header): header is string => header !== null)

  const alternativeEntity: DraftMimeSegment<T>[] = [
    `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
    '',
    `--${alternativeBoundary}`,
    ...textPart('text/plain', text),
    `--${alternativeBoundary}`,
    ...textPart('text/html', html),
    `--${alternativeBoundary}--`
  ]
  const bodyEntity: DraftMimeSegment<T>[] =
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
  const message: DraftMimeSegment<T>[] =
    regularAttachments.length === 0
      ? [...headers, ...bodyEntity]
      : [
          ...headers,
          `Content-Type: multipart/mixed; boundary="${mixedBoundary}"`,
          '',
          `--${mixedBoundary}`,
          ...bodyEntity,
          ...regularAttachments.flatMap((attachment) => [
            `--${mixedBoundary}`,
            ...attachmentPart(attachment)
          ]),
          `--${mixedBoundary}--`
        ]
  // The trailing empty segment is what gives the message its final CRLF.
  return [...message, '']
}

/** Minimal RFC 5322/2045 envelope for Gmail draft checkpoints; T15 owns final send MIME. */
export function encodeDraftMessage(input: DraftMimeInput): string {
  const body = draftMimeSegments(input)
    .map((segment) => (isAttachmentSegment(segment) ? wrapBase64(segment.attachment.content) : segment))
    .join(CRLF)
  return Buffer.from(body).toString('base64url')
}

function streamedBase64ByteLength(sizeBytes: number): number {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new Error('draft attachment size must be a non-negative safe integer')
  }
  const encodedBytes = 4 * Math.ceil(sizeBytes / 3)
  if (encodedBytes === 0) return 0
  return encodedBytes + (Math.ceil(encodedBytes / 76) - 1) * Buffer.byteLength(CRLF)
}

/** Exact byte count for streamDraftMessage; Gmail's multipart upload must declare it up front. */
export function draftMimeByteLength(input: DraftMimeInput<DraftMimeStreamAttachment>): number {
  const segments = draftMimeSegments(input)
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

async function* base64Stream(source: AsyncIterable<Uint8Array>): AsyncIterable<Uint8Array> {
  let carry = Buffer.alloc(0)
  let firstLine = true
  for await (const value of source) {
    const chunk = Buffer.from(value)
    const data = carry.length > 0 ? Buffer.concat([carry, chunk]) : chunk
    // 57 raw bytes encode to exactly one 76-character base64 line.
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
  if (carry.length > 0) yield Buffer.from(`${firstLine ? '' : CRLF}${carry.toString('base64')}`)
}

/** The same bytes encodeDraftMessage would produce, without holding attachments in memory. */
export async function* streamDraftMessage(
  input: DraftMimeInput<DraftMimeStreamAttachment>
): AsyncIterable<Uint8Array> {
  const segments = draftMimeSegments(input)
  for (const [index, segment] of segments.entries()) {
    if (isAttachmentSegment(segment)) yield* base64Stream(segment.attachment.open())
    else if (segment) yield Buffer.from(segment)
    if (index < segments.length - 1) yield Buffer.from(CRLF)
  }
}
