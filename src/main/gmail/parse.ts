// Gmail message payload parsing: headers, addresses, and body extraction.
// Both body formats are UNTRUSTED input. Plain text must stay in text nodes;
// raw HTML is sanitized and isolated by the renderer at display time.

export interface GmailHeader {
  name: string
  value: string
}

export interface GmailPart {
  partId?: string
  mimeType?: string
  filename?: string
  headers?: GmailHeader[]
  body?: { size?: number; data?: string; attachmentId?: string }
  parts?: GmailPart[]
}

export interface GmailMessage {
  id: string
  threadId: string
  labelIds?: string[]
  snippet?: string
  internalDate?: string
  payload?: GmailPart
}

export interface GmailThread {
  id: string
  historyId?: string
  messages?: GmailMessage[]
}

export function header(msg: GmailMessage, name: string): string {
  const h = msg.payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase())
  return h?.value ?? ''
}

export interface ThreadingHeaders {
  rfcMessageId: string | null
  references: string[]
}

/** Canonicalize RFC message-id header values while preserving their brackets. */
export function parseMessageIds(raw: string): string[] {
  const unfolded = raw.replace(/\r?\n[ \t]+/g, ' ').trim()
  if (!unfolded) return []

  const bracketed = [...unfolded.matchAll(/<([^<>\s]+)>/g)].map((match) => `<${match[1]}>`)
  if (bracketed.length > 0) return bracketed

  // Bare ids do occur in the wild. Require the RFC 5322 msg-id "@" so a malformed
  // header cannot invent ids that a later reply would put on the wire.
  return unfolded
    .split(/[\s,]+/)
    .map((value) => value.replace(/^<+|>+$/g, ''))
    .filter((value) => value.includes('@'))
    .map((value) => `<${value}>`)
}

/** Extract the headers needed to build standards-compliant reply threading. */
export function extractThreadingHeaders(message: GmailMessage): ThreadingHeaders {
  const references = parseMessageIds(header(message, 'References'))
  return {
    rfcMessageId: parseMessageIds(header(message, 'Message-ID'))[0] ?? null,
    references: references.length > 0 ? references : parseMessageIds(header(message, 'In-Reply-To'))
  }
}

export function parseAddress(raw: string): { name: string; email: string } {
  const m = raw.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/)
  if (m) {
    const name = m[1].trim()
    const email = m[2].trim()
    return { name: name || email.split('@')[0], email }
  }
  const email = raw.trim()
  return { name: email.split('@')[0] || email, email }
}

/** Split an RFC-style address header without breaking quoted display names. */
export function parseAddressList(raw: string): { name: string; email: string }[] {
  const parts: string[] = []
  let start = 0
  let quoted = false
  let escaped = false
  let angleDepth = 0

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quoted) {
      escaped = true
      continue
    }
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && char === '<') angleDepth++
    else if (!quoted && char === '>') angleDepth = Math.max(0, angleDepth - 1)
    else if (!quoted && angleDepth === 0 && char === ',') {
      parts.push(raw.slice(start, i))
      start = i + 1
    }
  }
  parts.push(raw.slice(start))

  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map(parseAddress)
    .filter((address) => address.email.length > 0)
}

export interface ParsedAttachment {
  attachmentId: string
  filename: string
  mimeType: string
  sizeBytes: number
  contentId?: string
  inline?: boolean
  /** Present only when Gmail delivered a small attachment inline with the message payload. */
  inlineData?: string
}

function partHeader(part: GmailPart, name: string): string {
  return part.headers?.find((candidate) => candidate.name.toLowerCase() === name)?.value.trim() ?? ''
}

/** Collect both user-visible attachments and CID-backed inline MIME resources. */
export function collectAttachments(payload: GmailPart | undefined): ParsedAttachment[] {
  const attachments: ParsedAttachment[] = []
  const walk = (part: GmailPart, path: string): void => {
    const filename = part.filename?.trim()
    const inlineData = typeof part.body?.data === 'string' ? part.body.data : undefined
    const attachmentId =
      part.body?.attachmentId ??
      (inlineData !== undefined ? `inline:${part.partId?.trim() || path}` : undefined)
    const contentId = partHeader(part, 'content-id').replace(/^<|>$/g, '')
    const disposition = partHeader(part, 'content-disposition').split(';', 1)[0].toLowerCase()
    const mimeType = part.mimeType ?? 'application/octet-stream'
    const inline = Boolean(
      contentId && mimeType.toLowerCase().startsWith('image/') && disposition !== 'attachment'
    )
    if (attachmentId && (filename || inline)) {
      attachments.push({
        attachmentId,
        filename: filename || contentId || `inline-image-${part.partId?.trim() || path}`,
        mimeType,
        sizeBytes: Math.max(
          0,
          part.body?.size ?? (inlineData === undefined ? 0 : Buffer.from(inlineData, 'base64url').byteLength)
        ),
        ...(contentId ? { contentId } : {}),
        ...(inline ? { inline: true } : {}),
        ...(part.body?.attachmentId ? {} : { inlineData })
      })
    }
    part.parts?.forEach((child, index) => {
      walk(child, `${path}.${index}`)
    })
  }
  if (payload) walk(payload, '0')
  return attachments
}

/** Recursive walk: text/plain wins, text/html (stripped) is the fallback. */
export function extractBodyText(payload: GmailPart | undefined): string {
  if (!payload) return ''
  const plains: string[] = []
  const htmls: string[] = []

  const walk = (part: GmailPart): void => {
    // Inline content only — parts with attachmentId and no data are attachments.
    const data = part.body?.data
    if (data && !part.filename) {
      const text = decodeBody(data)
      if (part.mimeType === 'text/plain') plains.push(text)
      else if (part.mimeType === 'text/html') htmls.push(text)
    }
    part.parts?.forEach(walk)
  }
  walk(payload)

  if (plains.length > 0) return normalize(plains.join('\n\n'))
  if (htmls.length > 0) return normalize(stripHtml(htmls.join('\n')))
  return ''
}

/** Recursive walk collecting raw inline text/html parts for render-time sanitization. */
export function extractBodyHtml(payload: GmailPart | undefined): string {
  if (!payload) return ''
  const htmls: string[] = []

  const walk = (part: GmailPart): void => {
    const data = part.body?.data
    if (data && !part.filename && part.mimeType === 'text/html') htmls.push(decodeBody(data))
    part.parts?.forEach(walk)
  }
  walk(payload)

  return htmls.join('\n')
}

/** Whether the inline payload contains authored text/plain (rather than an HTML-derived fallback). */
export function hasInlinePlainText(payload: GmailPart | undefined): boolean {
  if (!payload) return false
  if (!payload.filename && payload.mimeType === 'text/plain' && payload.body?.data) return true
  return payload.parts?.some(hasInlinePlainText) ?? false
}

export interface ExternalTextPart {
  attachmentId: string
  mimeType: 'text/plain' | 'text/html'
}

/**
 * Large text/* parts that Gmail stores out-of-line (body.attachmentId, no
 * inline data). These are NOT user-visible attachments — no filename — and
 * must be fetched via messages.attachments.get to render the body.
 */
export function findExternalTextParts(payload: GmailPart | undefined): ExternalTextPart[] {
  const found: ExternalTextPart[] = []
  const walk = (p: GmailPart): void => {
    if (
      !p.filename &&
      p.body?.attachmentId &&
      !p.body.data &&
      (p.mimeType === 'text/plain' || p.mimeType === 'text/html')
    ) {
      found.push({ attachmentId: p.body.attachmentId, mimeType: p.mimeType })
    }
    p.parts?.forEach(walk)
  }
  if (payload) walk(payload)
  return found
}

/** Decode a fetched raw part into display text (same pipeline as inline parts). */
export function textFromRaw(mimeType: string, raw: string): string {
  return normalize(mimeType === 'text/html' ? stripHtml(raw) : raw)
}

export function decodeBase64Url(data: string): string {
  try {
    return Buffer.from(data, 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

export function hasAttachment(payload: GmailPart | undefined): boolean {
  return collectAttachments(payload).some((attachment) => !attachment.inline)
}

function decodeBody(data: string): string {
  try {
    return Buffer.from(data, 'base64url').toString('utf8')
  } catch {
    return ''
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h[1-6]|blockquote)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
}

function normalize(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
