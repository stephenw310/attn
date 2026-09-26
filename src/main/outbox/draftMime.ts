// Draft-checkpoint policy over the shared MIME core in `mime.ts` (review R12):
// which headers a Gmail draft carries, how its body is composed, and how its
// boundaries are derived. Everything mechanical — folding, RFC 2047 and 2231
// encoding, the multipart layout, base64 framing, streaming — is shared with
// the send encoder, so the two cannot drift apart again.

import { createHash } from 'node:crypto'
import type { MailAddress } from '../../shared/address'
import { escapeHtmlText as escapeHtml } from '../../shared/html'
import {
  type AttachmentIdentity,
  addressHeader,
  encodeSubject,
  foldHeader,
  joinMimeSegments,
  type MimeSegment,
  mimeSegments,
  mimeSegmentsByteLength,
  streamMimeSegments
} from './mime'
import { singleLine } from './text'

export { mimeFilename } from './mime'

export interface DraftMimeAttachment extends AttachmentIdentity {
  content: Uint8Array
}

/** Spool-backed attachment whose bytes are read only while the request streams. */
export interface DraftMimeStreamAttachment extends AttachmentIdentity {
  sizeBytes: number
  open: () => AsyncIterable<Uint8Array>
}

export interface DraftMimeInput<TAttachment extends AttachmentIdentity = DraftMimeAttachment> {
  senderEmail?: string
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

function boundary<T extends AttachmentIdentity>(
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

/**
 * The plain-text fallback body. Deliberately not the send encoder's `<div>`
 * form: this output is hashed into `remote_fingerprint`, so changing it would
 * make every stored text-only draft read as remotely changed exactly once.
 */
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

function draftMimeSegments<T extends AttachmentIdentity>(input: DraftMimeInput<T>): MimeSegment<T>[] {
  return mimeSegments({
    headers: [
      // A checkpoint mirrors half-typed recipients, so addresses are sanitized
      // rather than validated; the send encoder is the boundary that rejects.
      ...(input.senderEmail ? addressHeader('From', [{ name: '', email: input.senderEmail }], false) : []),
      ...addressHeader('To', input.to, false),
      ...addressHeader('Cc', input.cc, false),
      ...addressHeader('Bcc', input.bcc, false),
      ...(input.subject ? foldHeader('Subject', encodeSubject(input.subject)) : []),
      ...(input.inReplyTo ? foldHeader('In-Reply-To', singleLine(input.inReplyTo)) : []),
      ...(input.references?.length
        ? foldHeader('References', input.references.map(singleLine).filter(Boolean).join(' '))
        : [])
    ],
    text: draftTextBody(input),
    html: draftHtmlBody(input),
    attachments: input.attachments ?? [],
    boundary: (kind) => boundary(kind, input),
    normalizeNewlines: false
  })
}

/** Minimal RFC 5322/2045 envelope for Gmail draft checkpoints; T15 owns final send MIME. */
export function encodeDraftMessage(input: DraftMimeInput): string {
  return Buffer.from(joinMimeSegments(draftMimeSegments(input))).toString('base64url')
}

/** Exact byte count for streamDraftMessage; Gmail's multipart upload must declare it up front. */
export function draftMimeByteLength(input: DraftMimeInput<DraftMimeStreamAttachment>): number {
  return mimeSegmentsByteLength(draftMimeSegments(input))
}

/** The same bytes encodeDraftMessage would produce, without holding attachments in memory. */
export function streamDraftMessage(
  input: DraftMimeInput<DraftMimeStreamAttachment>
): AsyncIterable<Uint8Array> {
  return streamMimeSegments(draftMimeSegments(input))
}
