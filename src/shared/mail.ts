// Mail data contracts shared by main, preload, and renderer.

export interface ThreadRow {
  id: string
  fromDisplay: string
  subject: string
  snippet: string
  lastMsgAt: number
  unread: boolean
  starred: boolean
  hasAttachment: boolean
}

export interface ConversationMsg {
  id: string
  fromName: string
  fromEmail: string
  to: string
  at: number
  /** Plain-text fallback, rendered strictly as a text node. */
  bodyText: string
  /** Raw cached mail HTML. Untrusted until sanitized by the renderer. */
  bodyHtml: string | null
}

export interface Conversation {
  threadId: string
  subject: string
  messages: ConversationMsg[]
}

export type SyncState =
  | { phase: 'idle' }
  | { phase: 'syncing'; threadsDone: number }
  | { phase: 'error'; message: string }
