import { describe, expect, it } from 'vitest'
import { buildTriageQuestions, buildTriageState, type TriageMessageInput } from './splitTriageState'
import { SPLIT_TRIAGE_EXCERPT_CHARS } from './tuning'

const message = (overrides: Partial<TriageMessageInput> = {}): TriageMessageInput => ({
  fromName: 'Ada Lovelace',
  fromEmail: 'ada@example.com',
  snippet: 'Snippet fallback',
  bodyText: 'Please review the Q3 invoice before Friday.',
  labels: ['INBOX', 'UNREAD', 'CATEGORY_UPDATES'],
  recipientCount: 3,
  ...overrides
})

describe('split triage state', () => {
  it('carries only the disclosed fields for a single-message thread', () => {
    // The literal is the contract: anything a future edit adds to the state
    // shows up here as a diff before it reaches the service.
    expect(
      buildTriageState({
        subject: '  Q3   invoice\n review ',
        messageCount: 1,
        mailingList: false,
        first: message(),
        latest: message()
      })
    ).toEqual({
      subject: 'Q3 invoice review',
      sender: { name: 'Ada Lovelace', address: 'ada@example.com' },
      recipient_count: 3,
      gmail_categories: ['CATEGORY_UPDATES'],
      mailing_list: false,
      message_count: 1,
      first_message: {
        from: 'Ada Lovelace <ada@example.com>',
        excerpt: 'Please review the Q3 invoice before Friday.'
      }
    })
  })

  it('adds the latest message only when it differs from the first', () => {
    const state = buildTriageState({
      subject: 'Q3 invoice',
      messageCount: 2,
      mailingList: true,
      first: message(),
      latest: message({
        fromName: null,
        fromEmail: 'grace@example.com',
        bodyText: 'Approved, thank you.',
        labels: ['INBOX'],
        recipientCount: 1
      })
    })
    expect(state.latest_message).toEqual({ from: 'grace@example.com', excerpt: 'Approved, thank you.' })
    expect(state.sender).toEqual({ name: '', address: 'grace@example.com' })
    expect(state.recipient_count).toBe(1)
    expect(state.gmail_categories).toEqual([])
    expect(state.mailing_list).toBe(true)

    const repeated = buildTriageState({
      subject: 'Q3 invoice',
      messageCount: 2,
      mailingList: false,
      first: message(),
      latest: message()
    })
    expect(repeated).not.toHaveProperty('latest_message')
  })

  it('falls back to the snippet and bounds every excerpt', () => {
    const state = buildTriageState({
      subject: null,
      messageCount: 1,
      mailingList: false,
      first: message({ bodyText: '   ', snippet: 'Only a snippet' }),
      latest: message({ bodyText: 'x'.repeat(SPLIT_TRIAGE_EXCERPT_CHARS + 500) })
    })
    expect(state.first_message.excerpt).toBe('Only a snippet')
    expect(state.subject).toBe('')
    const long = buildTriageState({
      subject: 'long',
      messageCount: 2,
      mailingList: false,
      first: message(),
      latest: message({ bodyText: `word ${'x'.repeat(SPLIT_TRIAGE_EXCERPT_CHARS + 500)}` })
    })
    expect(long.latest_message?.excerpt).toHaveLength(SPLIT_TRIAGE_EXCERPT_CHARS)
  })

  it('never exposes recipients, attachments, or HTML', () => {
    const state = buildTriageState({
      subject: 'Q3 invoice',
      messageCount: 1,
      mailingList: false,
      first: message(),
      latest: message()
    })
    expect(Object.keys(state)).toEqual([
      'subject',
      'sender',
      'recipient_count',
      'gmail_categories',
      'mailing_list',
      'message_count',
      'first_message'
    ])
  })

  it('asks one code-named question per described split and maps the answer back', () => {
    const rules = [
      { splitId: 'custom:one', name: 'Invoices', description: 'Bills I have to pay', descriptionHash: 'h1' },
      { splitId: 'custom:two', name: 'Recruiters', description: 'Cold hiring pitches', descriptionHash: 'h2' }
    ]
    const { questions, targets } = buildTriageQuestions(rules)
    expect(Object.keys(questions)).toEqual(['s0', 's1'])
    expect(questions.s0).toEqual({
      type: 'noul',
      instructions:
        'The user keeps a mailbox named "Invoices" and described what belongs in it. ' +
        'Decide whether this conversation belongs in that mailbox. ' +
        'Judge it by its content, its sender, and its purpose, not by its wording alone.',
      criteria: {
        true: { what: 'Bills I have to pay' },
        false: { what: 'The conversation does not fit that description' }
      }
    })
    expect(targets).toEqual({
      s0: { splitId: 'custom:one', descriptionHash: 'h1' },
      s1: { splitId: 'custom:two', descriptionHash: 'h2' }
    })
    expect(buildTriageQuestions([])).toEqual({ questions: {}, targets: {} })
  })
})
