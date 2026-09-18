// What a smart-splits judgment is allowed to know about one conversation, and
// how the question about each described split is worded. Pure: no SQLite, no
// network, no clock — the background pass supplies rows, and a dogfood eval
// script builds the same payloads from a fixture to tune the wording.
//
// The state is a deliberate cut, not everything the store holds. TypeSafe's
// System One models read state literally and unrelated detail costs accuracy,
// so the thread arrives as subject, who wrote it, how wide it is, the Gmail
// categories, and two bounded excerpts. Recipient addresses, attachments and
// HTML are outside the judgment and therefore outside the request.

import { SPLIT_TRIAGE_EXCERPT_CHARS } from './tuning'

/** One message as the state builder sees it: store columns, already parsed. */
export interface TriageMessageInput {
  fromName: string | null
  fromEmail: string | null
  snippet: string | null
  bodyText: string | null
  /** Gmail label ids on the message; `CATEGORY_*` are the ones state carries. */
  labels: readonly string[]
  /** To + Cc + Bcc on the message. The count travels, the addresses do not. */
  recipientCount: number
}

export interface TriageThreadInput {
  subject: string | null
  messageCount: number
  /** True when any message in the thread carries a List-Id header. */
  mailingList: boolean
  first: TriageMessageInput
  /** The same object as `first` on a single-message thread. */
  latest: TriageMessageInput
}

export interface TriageStateMessage {
  from: string
  excerpt: string
}

export interface TriageState {
  subject: string
  sender: { name: string; address: string }
  recipient_count: number
  gmail_categories: string[]
  mailing_list: boolean
  message_count: number
  first_message: TriageStateMessage
  /** Omitted when the thread holds one message: the same text twice misleads. */
  latest_message?: TriageStateMessage
}

export interface NoulQuestion {
  type: 'noul'
  instructions: string
  criteria: { true: { what: string }; false: { what: string } }
}

/** What a question id answers for, so the pass can store the answer. */
export interface TriageQuestionTarget {
  splitId: string
  descriptionHash: string
}

export interface TriageQuestionSet {
  questions: Record<string, NoulQuestion>
  targets: Record<string, TriageQuestionTarget>
}

/** The rule fields a question needs. `main/splits.ts` produces these. */
export interface TriageRule {
  splitId: string
  name: string
  description: string
  descriptionHash: string
}

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

export function triageExcerpt(message: TriageMessageInput): string {
  const source = message.bodyText?.trim() ? message.bodyText : (message.snippet ?? '')
  return collapse(source).slice(0, SPLIT_TRIAGE_EXCERPT_CHARS)
}

function displayFrom(message: TriageMessageInput): string {
  const name = collapse(message.fromName ?? '')
  const address = collapse(message.fromEmail ?? '')
  if (name && address) return `${name} <${address}>`
  return name || address
}

function stateMessage(message: TriageMessageInput): TriageStateMessage {
  return { from: displayFrom(message), excerpt: triageExcerpt(message) }
}

function gmailCategories(message: TriageMessageInput): string[] {
  return message.labels.filter((label) => label.startsWith('CATEGORY_'))
}

/**
 * Build one thread's judgment state. Sender, recipient count and categories
 * describe the latest message: triage answers "does this conversation belong
 * here now", and the newest arrival is what changed.
 */
export function buildTriageState(input: TriageThreadInput): TriageState {
  const first = stateMessage(input.first)
  const latest = stateMessage(input.latest)
  const sameMessage = first.from === latest.from && first.excerpt === latest.excerpt
  return {
    subject: collapse(input.subject ?? ''),
    sender: {
      name: collapse(input.latest.fromName ?? ''),
      address: collapse(input.latest.fromEmail ?? '')
    },
    recipient_count: input.latest.recipientCount,
    gmail_categories: gmailCategories(input.latest),
    mailing_list: input.mailingList,
    message_count: input.messageCount,
    first_message: first,
    ...(input.messageCount > 1 && !sameMessage ? { latest_message: latest } : {})
  }
}

/**
 * The single home for the question wording. The eval tunes this text, so keep
 * it here rather than assembling fragments at the call site.
 */
export function triageInstructions(splitName: string): string {
  return (
    `The user keeps a mailbox named "${splitName}" and described what belongs in it. ` +
    'Decide whether this conversation belongs in that mailbox. ' +
    'Judge it by its content, its sender, and its purpose, not by its wording alone.'
  )
}

export const TRIAGE_FALSE_CRITERION = 'The conversation does not fit that description'

/**
 * One Noul question per described split, evaluated in parallel against one
 * state. Question ids are code-only (`s0`, `s1`, …): split ids are user data
 * and have no business in the request body.
 */
export function buildTriageQuestions(rules: readonly TriageRule[]): TriageQuestionSet {
  const questions: Record<string, NoulQuestion> = {}
  const targets: Record<string, TriageQuestionTarget> = {}
  rules.forEach((rule, index) => {
    const id = `s${index}`
    questions[id] = {
      type: 'noul',
      instructions: triageInstructions(rule.name),
      criteria: { true: { what: rule.description }, false: { what: TRIAGE_FALSE_CRITERION } }
    }
    targets[id] = { splitId: rule.splitId, descriptionHash: rule.descriptionHash }
  })
  return { questions, targets }
}
