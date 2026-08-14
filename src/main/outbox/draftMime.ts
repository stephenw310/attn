import type { MailAddress } from '../../shared/address'

export interface DraftMimeInput {
  to: readonly MailAddress[]
  cc: readonly MailAddress[]
  bcc: readonly MailAddress[]
  subject: string
  bodyHtml: string
  bodyText: string
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

function wrapBase64(value: string): string {
  return value.match(/.{1,76}/g)?.join('\r\n') ?? ''
}

/** Minimal RFC 5322/2045 envelope for Gmail draft checkpoints; T15 owns final send MIME. */
export function encodeDraftMessage(input: DraftMimeInput): string {
  const body = input.bodyHtml || `<p>${escapeHtml(input.bodyText).replace(/\n/g, '<br>')}</p>`
  const headers = [
    addressHeader('To', input.to),
    addressHeader('Cc', input.cc),
    addressHeader('Bcc', input.bcc),
    input.subject ? foldHeader('Subject', encodeHeaderText(input.subject)) : null,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=UTF-8',
    'Content-Transfer-Encoding: base64'
  ].filter((header): header is string => header !== null)
  const raw = `${headers.join('\r\n')}\r\n\r\n${wrapBase64(Buffer.from(body).toString('base64'))}`
  return Buffer.from(raw).toString('base64url')
}
