import { createHash } from 'node:crypto'
import type { MailAddress } from '../../shared/address'

export interface DraftMimeAttachment {
  filename: string
  mimeType: string
  content: Uint8Array
  contentId?: string
  inline?: boolean
}

export interface DraftMimeInput {
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
  attachments?: readonly DraftMimeAttachment[]
}

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
  const tokens = value.split(/\s+/).filter(Boolean)
  const lines = [`${name}:`]
  for (const token of tokens) {
    const current = lines.at(-1) ?? `${name}:`
    if (`${current} ${token}`.length <= RECOMMENDED_HEADER_WIDTH) {
      lines[lines.length - 1] = `${current} ${token}`
    } else {
      lines.push(` ${token}`)
    }
  }
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

function quotedFilename(value: string): string {
  const clean =
    cleanHeader(value)
      .replace(/[^\x20-\x7e]/g, '_')
      .slice(0, 200) || 'inline-image'
  return `"${clean.replace(/["\\]/g, '\\$&')}"`
}

function boundary(kind: 'alternative' | 'related' | 'mixed', input: DraftMimeInput): string {
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

function attachmentPart(attachment: DraftMimeAttachment): string[] {
  const contentId = cleanHeader(attachment.contentId ?? '').replace(/^<|>$/g, '')
  return [
    `Content-Type: ${safeMimeType(attachment.mimeType)}; name=${quotedFilename(attachment.filename)}`,
    'Content-Transfer-Encoding: base64',
    `Content-Disposition: ${attachment.inline ? 'inline' : 'attachment'}; filename=${quotedFilename(attachment.filename)}`,
    ...(contentId ? [`Content-ID: <${contentId}>`] : []),
    '',
    wrapBase64(attachment.content)
  ]
}

/** Minimal RFC 5322/2045 envelope for Gmail draft checkpoints; T15 owns final send MIME. */
export function encodeDraftMessage(input: DraftMimeInput): string {
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

  const alternativeEntity = [
    `Content-Type: multipart/alternative; boundary="${alternativeBoundary}"`,
    '',
    `--${alternativeBoundary}`,
    ...textPart('text/plain', text),
    `--${alternativeBoundary}`,
    ...textPart('text/html', html),
    `--${alternativeBoundary}--`
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
  const message =
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
  return Buffer.from(`${message.join('\r\n')}\r\n`).toString('base64url')
}
