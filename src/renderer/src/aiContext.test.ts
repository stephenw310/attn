// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { aiThreadContext } from './aiContext'
import type { DisplayConversation, DisplayMessage } from './mailDisplay'

function message(patch: Partial<DisplayMessage> & { id: string }): DisplayMessage {
  return {
    pending: false,
    trashed: false,
    fromName: 'Maya Lin',
    fromEmail: 'maya@example.com',
    at: '10:12 AM',
    fullDate: 'Mon, Aug 31, 2026, 10:12 AM',
    recipients: { to: [], cc: [], bcc: [], replyTo: [] },
    attachments: [],
    text: '',
    html: null,
    bodyState: 'complete',
    ...patch
  }
}

function conversation(messages: DisplayMessage[]): DisplayConversation {
  return { threadId: 't-1', subject: 'Subject', messages, bodyHydrationFailed: false }
}

describe('aiThreadContext', () => {
  it('is null with no conversation and empty with no readable text', () => {
    expect(aiThreadContext(null)).toBeNull()
    expect(aiThreadContext(conversation([message({ id: 'm-1' })]))).toEqual([])
  })

  it('uses plain text, falls back to inert HTML extraction, and names the author', () => {
    const context = aiThreadContext(
      conversation([
        message({ id: 'm-1', text: 'Plain body.' }),
        message({
          id: 'm-2',
          fromName: '',
          fromEmail: 'theo@example.com',
          html: '<style>p{color:red}</style><p>From <b>HTML</b>.</p><script>alert(1)</script>'
        })
      ])
    )
    expect(context).toEqual([
      { author: 'Maya Lin', text: 'Plain body.' },
      { author: 'theo@example.com', text: 'From HTML.' }
    ])
  })

  it('skips pending and trashed messages and keeps only the newest twelve', () => {
    const many = Array.from({ length: 15 }, (_, index) =>
      message({ id: `m-${index}`, text: `Body ${index}` })
    )
    const context = aiThreadContext(
      conversation([
        message({ id: 'm-pending', pending: true, text: 'Unconfirmed' }),
        message({ id: 'm-trashed', trashed: true, text: 'Trashed' }),
        ...many
      ])
    )
    expect(context).toHaveLength(12)
    expect(context?.[0]?.text).toBe('Body 3')
    expect(context?.at(-1)?.text).toBe('Body 14')
    expect(context?.some((entry) => entry.text.includes('Unconfirmed'))).toBe(false)
  })

  it('bounds each message to the per-message excerpt limit', () => {
    const context = aiThreadContext(conversation([message({ id: 'm-1', text: 'x'.repeat(10_000) })]))
    expect(context?.[0]?.text).toHaveLength(4_000)
  })
})
