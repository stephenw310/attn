import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { DraftInlineImageInput, DraftInlineImageResult } from '../../shared/drafts'
import type { Db } from '../db'
import {
  parseStoredDraftAttachments,
  publicDraftAttachment,
  type StoredDraftAttachment
} from './draftAttachments'
import { validateAttachmentCap } from './spool'

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const IMAGE_MIME = /^image\/(?:png|jpeg|gif|webp)$/i

export function isSupportedInlineImageMimeType(value: string): boolean {
  return IMAGE_MIME.test(value)
}

function safeFilename(value: string): string {
  return basename(value.replace(/[\0\r\n]/g, '').trim()) || 'pasted-image'
}

export async function addInlineImage(
  db: Db,
  userData: string,
  accountId: string,
  draftId: string,
  input: DraftInlineImageInput,
  now = Date.now()
): Promise<DraftInlineImageResult> {
  if (!isSupportedInlineImageMimeType(input.mimeType)) throw new Error('unsupported inline image type')
  if (input.dataBase64.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 4) {
    throw new Error('inline image must be between 1 byte and 10 MB')
  }
  const content = Buffer.from(input.dataBase64, 'base64')
  if (content.byteLength === 0 || content.byteLength > MAX_IMAGE_BYTES) {
    throw new Error('inline image must be between 1 byte and 10 MB')
  }
  const row = db
    .prepare(
      `SELECT attachments_json FROM outbox
       WHERE account_id = ? AND id = ? AND state = 'composing'`
    )
    .get(accountId, draftId) as { attachments_json: string } | undefined
  if (!row) throw new Error('draft is unavailable')
  const attachments = parseStoredDraftAttachments(row.attachments_json)
  const used = attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0)
  validateAttachmentCap(used, [content.byteLength])

  const filename = safeFilename(input.filename)
  const contentId = `${randomUUID()}@attn.local`
  const directory = join(userData, 'outbox', draftId)
  // The original name lives in metadata. A UUID-only storage name keeps the
  // path component under NAME_MAX no matter how long the pasted name is.
  const spoolPath = join(directory, randomUUID())
  await mkdir(directory, { recursive: true })
  await writeFile(spoolPath, content, { flag: 'wx' })
  const attachment: StoredDraftAttachment = {
    id: randomUUID(),
    filename,
    mimeType: input.mimeType.toLowerCase(),
    sizeBytes: content.byteLength,
    spoolPath,
    contentId,
    inline: true
  }
  try {
    let snapshot: { attachments_json: string } | undefined = row
    for (let attempt = 0; attempt < 5; attempt++) {
      if (attempt > 0) {
        snapshot = db
          .prepare(
            `SELECT attachments_json FROM outbox
             WHERE account_id = ? AND id = ? AND state = 'composing'`
          )
          .get(accountId, draftId) as { attachments_json: string } | undefined
      }
      if (!snapshot) throw new Error('draft is unavailable')
      const current = parseStoredDraftAttachments(snapshot.attachments_json)
      const currentBytes = current.reduce((total, item) => total + item.sizeBytes, 0)
      validateAttachmentCap(currentBytes, [content.byteLength])
      const next = [...current, attachment]
      const changed = db
        .prepare(
          `UPDATE outbox SET attachments_json = ?, updated_at = ?, local_revision = local_revision + 1
           WHERE account_id = ? AND id = ? AND state = 'composing' AND attachments_json = ?`
        )
        .run(JSON.stringify(next), now, accountId, draftId, snapshot.attachments_json).changes
      if (changed > 0) {
        return {
          attachment: publicDraftAttachment(attachment),
          dataUrl: `data:${attachment.mimeType};base64,${content.toString('base64')}`
        }
      }
    }
    throw new Error('Attachments changed — try pasting again')
  } catch (error) {
    await rm(spoolPath, { force: true }).catch(() => {})
    throw error
  }
}
