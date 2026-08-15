import { createHash } from 'node:crypto'
import type { DraftAttachment } from '../../shared/drafts'

/** Main-process-only attachment data. None of these locators cross the preload bridge. */
export interface StoredDraftAttachment extends DraftAttachment {
  spoolPath: string
  remoteMessageId?: string
  remoteAttachmentId?: string
  /** Small Gmail MIME parts arrive inline on drafts.get and are decoded only when rendered. */
  remoteInlineData?: string
}

function legacyAttachmentId(attachment: Omit<StoredDraftAttachment, 'id'>): string {
  const identity = [
    attachment.spoolPath,
    attachment.remoteMessageId,
    attachment.remoteAttachmentId,
    attachment.contentId,
    attachment.filename,
    attachment.mimeType,
    attachment.sizeBytes
  ].join('\0')
  return `legacy-${createHash('sha256').update(identity).digest('hex').slice(0, 24)}`
}

/** Accept rows written before attachment ids existed without exposing their storage details. */
export function parseStoredDraftAttachments(value: string): StoredDraftAttachment[] {
  const parsed = JSON.parse(value) as (StoredDraftAttachment | Omit<StoredDraftAttachment, 'id'>)[]
  return parsed.map((attachment) =>
    'id' in attachment && typeof attachment.id === 'string' && attachment.id
      ? attachment
      : { ...attachment, id: legacyAttachmentId(attachment) }
  )
}

export function publicDraftAttachment(attachment: StoredDraftAttachment): DraftAttachment {
  return {
    id: attachment.id,
    filename: attachment.filename,
    mimeType: attachment.mimeType,
    sizeBytes: attachment.sizeBytes,
    ...(attachment.contentId ? { contentId: attachment.contentId } : {}),
    ...(attachment.inline ? { inline: true } : {})
  }
}

export function publicDraftAttachments(attachments: readonly StoredDraftAttachment[]): DraftAttachment[] {
  return attachments.map(publicDraftAttachment)
}
