// Renderer-side view types for the M0 mock inbox.
// The real data contract (SQLite-backed) replaces these when sync lands.

export interface ThreadSummary {
  id: string
  from: string
  subject: string
  snippet: string
  at: string
  unread: boolean
  starred?: boolean
  hasAttachment?: boolean
}

export interface MessageView {
  id: string
  fromName: string
  fromEmail: string
  to: string
  at: string
  body: string[]
}

export interface ConversationView {
  threadId: string
  subject: string
  messages: MessageView[]
}
