import type { MessageAttachment } from '../../shared/mail'

const SAFE_INLINE_IMAGE_MIME = /^image\/(?:png|jpeg|gif|webp)$/i

export function normalizedContentId(value: string): string {
  const trimmed = value.trim()
  try {
    return decodeURIComponent(trimmed).replace(/^<|>$/g, '').trim().toLowerCase()
  } catch {
    return trimmed.replace(/^<|>$/g, '').trim().toLowerCase()
  }
}

export interface InlineImageMatch {
  attachment: MessageAttachment
  contentIds: string[]
}

export interface InlineImageReference {
  contentId: string
  filenameHint?: string
}

function filenameMatches(reference: string, filename: string): boolean {
  return reference === filename || reference.startsWith(`${filename}@`)
}

/**
 * Match sanitized CID references to safe image MIME parts. A direct Content-ID
 * always wins. Some senders instead put a friendly filename such as
 * `cid:image.png` in the HTML while retaining a generated MIME Content-ID; use
 * that filename only when it identifies exactly one image.
 */
export function matchInlineImageReferences(
  attachments: readonly MessageAttachment[],
  references: readonly InlineImageReference[]
): InlineImageMatch[] {
  const images = attachments.filter((attachment) => SAFE_INLINE_IMAGE_MIME.test(attachment.mimeType))
  const referenceHints = new Map<string, Set<string>>()
  for (const reference of references) {
    const contentId = normalizedContentId(reference.contentId)
    if (!contentId) continue
    const filenameHint = reference.filenameHint ? normalizedContentId(reference.filenameHint) : undefined
    const hints = referenceHints.get(contentId) ?? new Set<string>()
    if (filenameHint) hints.add(filenameHint)
    referenceHints.set(contentId, hints)
  }
  const matches = new Map<MessageAttachment, string[]>()
  const claimed = new Set<string>()

  const add = (attachment: MessageAttachment, reference: string): void => {
    matches.set(attachment, [...(matches.get(attachment) ?? []), reference])
    claimed.add(reference)
  }

  for (const reference of referenceHints.keys()) {
    const direct = images.filter(
      (attachment) =>
        attachment.contentId !== undefined && normalizedContentId(attachment.contentId) === reference
    )
    if (direct.length === 1) add(direct[0], reference)
  }

  for (const [reference, hints] of referenceHints) {
    if (claimed.has(reference)) continue
    const filenameHint = hints.size === 1 ? [...hints][0] : undefined
    const byFilename = images.filter((attachment) => {
      const filename = normalizedContentId(attachment.filename)
      return filename.length > 0 && (filenameMatches(reference, filename) || filenameHint === filename)
    })
    if (byFilename.length === 1) add(byFilename[0], reference)
  }

  return [...matches].map(([attachment, contentIds]) => ({ attachment, contentIds }))
}
