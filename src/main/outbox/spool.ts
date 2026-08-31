import { randomUUID } from 'node:crypto'
import { constants, type Dirent, type Stats } from 'node:fs'
import { copyFile, mkdir, readdir, rm, rmdir, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, resolve } from 'node:path'
import type { DraftAttachmentMutationResult } from '../../shared/drafts'
import type { Db } from '../db'
import { isPathInside } from '../pathSafety'
import {
  parseStoredDraftAttachments,
  publicDraftAttachments,
  type StoredDraftAttachment
} from './draftAttachments'

export const MAX_DRAFT_ATTACHMENT_BYTES = 25 * 1024 * 1024
export const MAX_DRAFT_ATTACHMENT_PATHS = 100

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.json': 'application/json',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.rtf': 'application/rtf',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain',
  '.webp': 'image/webp',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.zip': 'application/zip'
}

interface IncomingAttachment {
  sourcePath: string
  filename: string
  mimeType: string
  sizeBytes: number
}

export function validateAttachmentCap(existingBytes: number, incomingSizes: readonly number[]): void {
  if (
    !Number.isSafeInteger(existingBytes) ||
    existingBytes < 0 ||
    incomingSizes.some((size) => !Number.isSafeInteger(size) || size < 0)
  ) {
    throw new Error('Attachment size is invalid')
  }
  if (incomingSizes.some((size) => size > MAX_DRAFT_ATTACHMENT_BYTES)) {
    throw new Error('Each attachment must be 25 MB or less')
  }
  const incomingBytes = incomingSizes.reduce((total, size) => total + size, 0)
  if (!Number.isSafeInteger(incomingBytes) || existingBytes + incomingBytes > MAX_DRAFT_ATTACHMENT_BYTES) {
    throw new Error('Attachments must total 25 MB or less')
  }
}

function safeFilename(value: string): string {
  return basename(value.replace(/[\0\r\n]/g, '').trim()) || 'attachment'
}

function mimeTypeFor(filename: string): string {
  return MIME_BY_EXTENSION[extname(filename).toLowerCase()] ?? 'application/octet-stream'
}

function ownedSpoolPath(userDataPath: string, draftId: string, candidate: string): boolean {
  const draftRoot = resolve(userDataPath, 'outbox', draftId)
  const target = resolve(candidate)
  return isPathInside(draftRoot, target)
}

async function inspectSource(sourcePath: string): Promise<IncomingAttachment> {
  if (!isAbsolute(sourcePath)) throw new Error('Attachment path is invalid')
  const filename = safeFilename(sourcePath)
  let details: Stats
  try {
    details = await stat(sourcePath)
  } catch {
    throw new Error(`Attachment is unavailable: ${filename}`)
  }
  if (!details.isFile()) throw new Error('Only files can be attached')
  return {
    sourcePath,
    filename,
    mimeType: mimeTypeFor(filename),
    sizeBytes: details.size
  }
}

export async function spoolDraftAttachments(
  db: Db,
  userDataPath: string,
  accountId: string,
  draftId: string,
  paths: readonly string[],
  now?: number
): Promise<DraftAttachmentMutationResult> {
  if (paths.length > MAX_DRAFT_ATTACHMENT_PATHS) {
    throw new Error(`Attach no more than ${MAX_DRAFT_ATTACHMENT_PATHS} files at once`)
  }
  const row = db
    .prepare(
      `SELECT attachments_json FROM outbox
       WHERE account_id = ? AND id = ? AND state = 'composing'`
    )
    .get(accountId, draftId) as { attachments_json: string } | undefined
  if (!row) throw new Error('draft is unavailable')
  const attachments = parseStoredDraftAttachments(row.attachments_json)
  if (paths.length === 0) return { attachments: publicDraftAttachments(attachments), changed: false }

  const incoming = await Promise.all(paths.map(inspectSource))
  const existingBytes = attachments.reduce((total, attachment) => total + attachment.sizeBytes, 0)
  validateAttachmentCap(
    existingBytes,
    incoming.map((attachment) => attachment.sizeBytes)
  )

  const directory = join(userDataPath, 'outbox', draftId)
  const copied: string[] = []
  const added: StoredDraftAttachment[] = []
  try {
    try {
      await mkdir(directory, { recursive: true })
    } catch {
      throw new Error('Could not prepare attachment storage')
    }
    for (const source of incoming) {
      // The original name lives in metadata. A UUID-only storage name avoids
      // exceeding filesystem component limits when the source name is already
      // close to its platform maximum.
      const spoolPath = join(directory, randomUUID())
      let copiedSize: number
      try {
        await copyFile(source.sourcePath, spoolPath, constants.COPYFILE_EXCL)
        copied.push(spoolPath)
        copiedSize = (await stat(spoolPath)).size
      } catch {
        throw new Error(`Could not copy attachment: ${source.filename}`)
      }
      validateAttachmentCap(existingBytes + added.reduce((total, item) => total + item.sizeBytes, 0), [
        copiedSize
      ])
      added.push({
        id: randomUUID(),
        filename: source.filename,
        mimeType: source.mimeType,
        sizeBytes: copiedSize,
        spoolPath
      })
    }
    // A pasted inline image can land between the read above and this write.
    // Re-read and re-check the cap rather than discarding bytes already copied.
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
      validateAttachmentCap(
        current.reduce((total, item) => total + item.sizeBytes, 0),
        added.map((item) => item.sizeBytes)
      )
      const next = [...current, ...added]
      const changed = db
        .prepare(
          `UPDATE outbox SET attachments_json = ?, updated_at = ?, local_revision = local_revision + 1
           WHERE account_id = ? AND id = ? AND state = 'composing' AND attachments_json = ?`
        )
        .run(JSON.stringify(next), now ?? Date.now(), accountId, draftId, snapshot.attachments_json).changes
      if (changed > 0) return { attachments: publicDraftAttachments(next), changed: true }
    }
    throw new Error('Attachments changed — try attaching again')
  } catch (error) {
    await Promise.all(copied.map((path) => rm(path, { force: true }).catch(() => {})))
    // This succeeds only when the failed attempt created an otherwise-empty
    // directory, so it cannot remove another attachment mutation's files.
    await rmdir(directory).catch(() => {})
    throw error
  }
}

export async function removeDraftAttachment(
  db: Db,
  userDataPath: string,
  accountId: string,
  draftId: string,
  attachmentId: string,
  now = Date.now()
): Promise<DraftAttachmentMutationResult> {
  const row = db
    .prepare(
      `SELECT attachments_json FROM outbox
       WHERE account_id = ? AND id = ? AND state = 'composing'`
    )
    .get(accountId, draftId) as { attachments_json: string } | undefined
  if (!row) throw new Error('draft is unavailable')
  const attachments = parseStoredDraftAttachments(row.attachments_json)
  const removed = attachments.find((attachment) => attachment.id === attachmentId)
  if (!removed) throw new Error('attachment is unavailable')
  const next = attachments.filter((attachment) => attachment.id !== attachmentId)
  const changed = db
    .prepare(
      `UPDATE outbox SET attachments_json = ?, updated_at = ?, local_revision = local_revision + 1
       WHERE account_id = ? AND id = ? AND state = 'composing' AND attachments_json = ?`
    )
    .run(JSON.stringify(next), now, accountId, draftId, row.attachments_json).changes
  if (changed === 0) throw new Error('draft is unavailable')
  if (removed.spoolPath && ownedSpoolPath(userDataPath, draftId, removed.spoolPath)) {
    await rm(removed.spoolPath, { force: true }).catch(() => {})
  }
  return { attachments: publicDraftAttachments(next), changed: true }
}

/** Await deletion of an owned attachment directory, reporting any filesystem failure. */
export async function deleteOutboxSpool(userDataPath: string, id: string): Promise<void> {
  const root = resolve(userDataPath, 'outbox')
  const directory = resolve(root, id)
  if (!isPathInside(root, directory)) throw new Error('Invalid attachment spool directory')
  await rm(directory, { recursive: true, force: true, maxRetries: 3 })
}

/** Best-effort cleanup after send/discard; startup reconciliation retries leftovers. */
export function cleanOutboxSpool(userDataPath: string, id: string): void {
  void deleteOutboxSpool(userDataPath, id).catch(() => {})
}

/** Catch cleanup interrupted between the durable sent/discard transition and filesystem removal. */
export async function reconcileOutboxSpool(db: Db, userDataPath: string): Promise<void> {
  const root = resolve(userDataPath, 'outbox')
  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  // null means metadata could not be parsed: preserve the directory rather
  // than turning a damaged row into destructive cleanup.
  const retained = new Map<string, Set<string> | null>()
  const rows = db
    .prepare(
      `SELECT id, attachments_json FROM outbox
       WHERE state IN ('composing', 'drafted', 'queued', 'sending', 'failed', 'needs-review')
         AND attachments_json <> '[]'`
    )
    .all() as { id: string; attachments_json: string }[]
  for (const row of rows) {
    const draftRoot = resolve(root, row.id)
    if (!isPathInside(root, draftRoot)) continue
    let attachments: StoredDraftAttachment[]
    try {
      attachments = parseStoredDraftAttachments(row.attachments_json)
    } catch {
      retained.set(row.id, null)
      continue
    }
    const paths = new Set<string>()
    for (const attachment of attachments) {
      if (!attachment.spoolPath || !ownedSpoolPath(userDataPath, row.id, attachment.spoolPath)) continue
      paths.add(resolve(attachment.spoolPath))
    }
    if (paths.size > 0) retained.set(row.id, paths)
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = resolve(root, entry.name)
    if (!isPathInside(root, directory)) continue
    if (!retained.has(entry.name)) {
      await rm(directory, { recursive: true, force: true }).catch(() => {})
      continue
    }
    const retainedPaths = retained.get(entry.name)
    if (retainedPaths === null || retainedPaths === undefined) continue
    let children: Dirent[]
    try {
      children = await readdir(directory, { withFileTypes: true })
    } catch {
      continue
    }
    for (const child of children) {
      const candidate = resolve(directory, child.name)
      if (child.isFile() && retainedPaths.has(candidate)) continue
      await rm(candidate, { recursive: true, force: true }).catch(() => {})
    }
  }
}
