// Reply context for AI drafting (T37, F17): the open conversation's cached
// messages as bounded plain text. Extraction is local and inert — DOMParser
// text/html documents never execute scripts or load resources — and the
// bounds keep an explicit invocation's payload proportionate to a reply.

import type { AiThreadMessage } from '../../shared/ai'
import type { DisplayConversation, DisplayMessage } from './mailDisplay'

const MAX_CONTEXT_MESSAGES = 12
const MAX_MESSAGE_CHARS = 4_000

function messageText(message: DisplayMessage): string {
  const plain = message.text.trim()
  if (plain.length > 0) return plain
  if (!message.html) return ''
  const parsed = new DOMParser().parseFromString(message.html, 'text/html')
  for (const node of parsed.querySelectorAll('style, script, title')) node.remove()
  return (parsed.body.textContent ?? '')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * The newest messages of the open conversation as AI reply context. Pending
 * outbox projections and trashed markers are skipped — the provider sees only
 * confirmed conversation content the reader shows too.
 */
export function aiThreadContext(conversation: DisplayConversation | null): AiThreadMessage[] | null {
  if (!conversation) return null
  const messages: AiThreadMessage[] = []
  for (const message of conversation.messages) {
    if (message.pending || message.trashed) continue
    const text = messageText(message)
    if (text.length === 0) continue
    messages.push({
      author: message.fromName.trim() || message.fromEmail,
      text: text.slice(0, MAX_MESSAGE_CHARS)
    })
  }
  return messages.slice(-MAX_CONTEXT_MESSAGES)
}
