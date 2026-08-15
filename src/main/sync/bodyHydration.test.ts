import { describe, expect, it } from 'vitest'
import type { Conversation } from '../../shared/mail'
import { idleMissingBodyState, needsBodyHydration, relabelMissingBodyState } from './bodyHydration'

describe('needsBodyHydration', () => {
  it.each([
    { bodyText: null, bodyHtml: null },
    { bodyText: '', bodyHtml: null },
    { bodyText: '  ', bodyHtml: '\n' }
  ])('identifies metadata-only stored bodies: $bodyText / $bodyHtml', (body) => {
    expect(needsBodyHydration(body)).toBe(true)
  })

  it.each([
    { bodyText: 'A complete short message', bodyHtml: null },
    { bodyText: null, bodyHtml: '<p>A complete HTML message</p>' },
    { bodyText: 'Plain fallback', bodyHtml: '<p>HTML message</p>' }
  ])('accepts either cached body representation: $bodyText / $bodyHtml', (body) => {
    expect(needsBodyHydration(body)).toBe(false)
  })
})

describe('conversation body hydration state', () => {
  const conversation: Conversation = {
    threadId: 'thread-1',
    subject: 'Subject',
    messages: [
      {
        id: 'message-missing',
        rfcMessageId: null,
        references: [],
        fromName: 'Sender',
        fromEmail: 'sender@example.com',
        at: 0,
        recipients: { to: [], cc: [], bcc: [], replyTo: [] },
        attachments: [],
        bodyText: 'Cached snippet',
        bodyHtml: null,
        bodyState: 'signed-out'
      },
      {
        id: 'message-complete',
        rfcMessageId: null,
        references: [],
        fromName: 'Sender',
        fromEmail: 'sender@example.com',
        at: 1,
        recipients: { to: [], cc: [], bcc: [], replyTo: [] },
        attachments: [],
        bodyText: 'Complete body',
        bodyHtml: null,
        bodyState: 'complete'
      }
    ]
  }

  it('labels idle real-account reads as loadable and seeded reads as signed out', () => {
    expect(idleMissingBodyState(false)).toBe('loading')
    expect(idleMissingBodyState(true)).toBe('signed-out')
  })

  it('relabels only metadata-only messages without querying again', () => {
    const relabeled = relabelMissingBodyState(conversation, 'loading')
    expect(relabeled.messages.map((message) => message.bodyState)).toEqual(['loading', 'complete'])
    expect(relabeled.messages[1]).toBe(conversation.messages[1])
    expect(relabelMissingBodyState(conversation, 'signed-out')).toBe(conversation)
  })
})
