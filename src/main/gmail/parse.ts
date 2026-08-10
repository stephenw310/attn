// Gmail message payload parsing: headers, addresses, and body extraction.
// Bodies are reduced to plain text in M0. That text is UNTRUSTED input —
// the renderer must only ever place it in text nodes (no innerHTML).

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
  if (!payload) return false
  if (payload.filename && payload.filename.length > 0) return true
  return payload.parts?.some(hasAttachment) ?? false
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
  return text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
}
