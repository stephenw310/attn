import { describe, expect, it } from 'vitest'
import { type ConversationMailbox, messageLabelsMatchMailbox } from './mail'

const MAILBOXES: ConversationMailbox[] = ['normal', 'all-mail', 'spam', 'trash']

const labels = (...ids: string[]): ReadonlySet<string> => new Set(ids)

describe('messageLabelsMatchMailbox', () => {
  it('hides drafts and Chat rows from every mailbox', () => {
    // `persist` summarizes a thread from the messages a reader can show, and a
    // threaded Gmail draft must never become that summary.
    for (const mailbox of MAILBOXES) {
      expect(messageLabelsMatchMailbox(labels('DRAFT', 'INBOX'), mailbox), mailbox).toBe(false)
      expect(messageLabelsMatchMailbox(labels('CHAT'), mailbox), mailbox).toBe(false)
    }
    expect(messageLabelsMatchMailbox(labels('DRAFT', 'SPAM'), 'spam')).toBe(false)
    expect(messageLabelsMatchMailbox(labels('CHAT', 'TRASH'), 'trash')).toBe(false)
  })

  it('shows only matching junk in the junk mailboxes', () => {
    expect(messageLabelsMatchMailbox(labels('SPAM'), 'spam')).toBe(true)
    expect(messageLabelsMatchMailbox(labels('TRASH'), 'spam')).toBe(false)
    expect(messageLabelsMatchMailbox(labels('INBOX'), 'spam')).toBe(false)
    expect(messageLabelsMatchMailbox(labels('TRASH'), 'trash')).toBe(true)
    expect(messageLabelsMatchMailbox(labels('SPAM'), 'trash')).toBe(false)
    expect(messageLabelsMatchMailbox(labels(), 'trash')).toBe(false)
  })

  it('keeps junk out of the ordinary reader and All Mail', () => {
    for (const mailbox of ['normal', 'all-mail'] as const) {
      expect(messageLabelsMatchMailbox(labels('INBOX'), mailbox), mailbox).toBe(true)
      expect(messageLabelsMatchMailbox(labels(), mailbox), mailbox).toBe(true)
      expect(messageLabelsMatchMailbox(labels('SPAM'), mailbox), mailbox).toBe(false)
      expect(messageLabelsMatchMailbox(labels('TRASH'), mailbox), mailbox).toBe(false)
    }
  })

  it('files a message carrying both junk labels in both junk mailboxes', () => {
    const both = labels('SPAM', 'TRASH')
    expect(messageLabelsMatchMailbox(both, 'spam')).toBe(true)
    expect(messageLabelsMatchMailbox(both, 'trash')).toBe(true)
    expect(messageLabelsMatchMailbox(both, 'normal')).toBe(false)
  })

  it('treats All Mail exactly like the ordinary reader, with junk as its complement', () => {
    for (const ids of [[], ['INBOX'], ['SPAM'], ['TRASH'], ['SPAM', 'TRASH'], ['INBOX', 'STARRED']]) {
      const set = labels(...ids)
      const normal = messageLabelsMatchMailbox(set, 'normal')
      expect(messageLabelsMatchMailbox(set, 'all-mail'), ids.join(',')).toBe(normal)
      const junk = messageLabelsMatchMailbox(set, 'spam') || messageLabelsMatchMailbox(set, 'trash')
      expect(junk, ids.join(',')).toBe(!normal)
    }
  })
})
