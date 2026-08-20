import type { Db } from '../db'
import {
  decodeBase64Url,
  extractBodyHtml,
  extractBodyText,
  findExternalTextParts,
  type GmailThread,
  hasInlinePlainText
} from '../gmail/parse'
import { mergeExternalBodies } from './mergeBodies'
import type { MailProvider, ProviderRequestOptions } from './provider'

/** Fetch only out-of-line body parts that are not already complete locally. */
export async function hydrateMissingThreadBodies(
  db: Db,
  provider: MailProvider,
  accountId: string,
  thread: GmailThread,
  shouldContinue: () => boolean = () => true,
  requestOptions?: ProviderRequestOptions
): Promise<void> {
  const readBody = db.prepare('SELECT body_text, body_html FROM messages WHERE account_id = ? AND id = ?')
  const writeBody = db.prepare(
    'UPDATE messages SET body_text = ?, body_html = ? WHERE account_id = ? AND id = ?'
  )

  for (const message of thread.messages ?? []) {
    if (!shouldContinue()) return
    const row = readBody.get(accountId, message.id) as
      | { body_text: string | null; body_html: string | null }
      | undefined
    if (!row) continue
    const parts = findExternalTextParts(message.payload)
    if (parts.length === 0) continue

    const inlineText = extractBodyText(message.payload)
    const inlineHtml = extractBodyHtml(message.payload)
    const plainComplete = Boolean(row.body_text) && row.body_text !== inlineText
    const htmlComplete = Boolean(row.body_html) && row.body_html !== inlineHtml
    const fetchedPlain: string[] = []
    const fetchedHtml: string[] = []

    for (const part of parts) {
      if (!shouldContinue()) return
      if (part.mimeType === 'text/plain' && plainComplete) continue
      if (part.mimeType === 'text/html' && htmlComplete) continue
      const data = requestOptions
        ? await provider.getAttachmentData(message.id, part.attachmentId, requestOptions)
        : await provider.getAttachmentData(message.id, part.attachmentId)
      if (!shouldContinue()) return
      if (!data) continue
      const raw = decodeBase64Url(data)
      if (!raw) continue
      if (part.mimeType === 'text/html') fetchedHtml.push(raw)
      else fetchedPlain.push(raw)
    }

    if (fetchedPlain.length === 0 && fetchedHtml.length === 0) continue
    const { bodyText, bodyHtml } = mergeExternalBodies({
      storedText: row.body_text,
      storedHtml: row.body_html,
      inlineText,
      hasInlinePlain: hasInlinePlainText(message.payload),
      fetchedPlain,
      fetchedHtml
    })
    if (bodyText === row.body_text && bodyHtml === row.body_html) continue
    if (!shouldContinue()) return
    writeBody.run(bodyText, bodyHtml, accountId, message.id)
  }
}
