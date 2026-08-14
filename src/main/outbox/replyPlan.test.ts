import { describe, expect, it } from 'vitest'
import type { Conversation, ConversationMsg, MailAddress } from '../../shared/mail'
import { planReply, type ReplyKind, sanitizeQuoteHtml } from './replyPlan'

const SELF = 'me@example.com'
const EMPTY_RECIPIENTS = { to: [], cc: [], bcc: [], replyTo: [] }

function message(overrides: Partial<ConversationMsg> = {}): ConversationMsg {
  return {
    id: 'm1',
    rfcMessageId: '<m1@example.com>',
    references: ['<root@example.com>'],
    fromName: 'Maya Lin',
    fromEmail: 'maya@example.com',
    at: Date.parse('2026-08-13T11:00:00.000Z'),
    recipients: EMPTY_RECIPIENTS,
    attachments: [],
    bodyText: 'First line\n\nSecond line',
    bodyHtml: '<p>First <strong>line</strong></p><p>Second line</p>',
    ...overrides
  }
}

function conversation(messages: ConversationMsg[], subject = 'Roadmap'): Conversation {
  return { threadId: 'thread-1', subject, messages }
}

function address(name: string, email: string): MailAddress {
  return { name, email }
}

describe('reply planning', () => {
  it('replies to Reply-To on the latest non-self message', () => {
    const external = message({
      recipients: {
        ...EMPTY_RECIPIENTS,
        replyTo: [address('Roadmap replies', 'replies@example.com')]
      }
    })
    const newerSelf = message({
      id: 'm2',
      fromName: 'Me',
      fromEmail: SELF,
      at: external.at + 1_000,
      rfcMessageId: '<m2@example.com>'
    })

    const plan = planReply('reply', conversation([external, newerSelf]), SELF)

    expect(plan.to).toEqual([address('Roadmap replies', 'replies@example.com')])
    expect(plan.cc).toEqual([])
    expect(plan.inReplyTo).toBe('<m1@example.com>')
    expect(plan.references).toEqual(['<root@example.com>', '<m1@example.com>'])
    expect(plan.threadId).toBe('thread-1')
  })

  it('reply-all removes self and deduplicates To/Cc case-insensitively', () => {
    const source = message({
      recipients: {
        to: [address('Me', 'ME@example.com'), address('Dan', 'dan@example.com')],
        cc: [address('Maya duplicate', 'MAYA@example.com'), address('Priya', 'priya@example.com')],
        bcc: [address('Hidden', 'hidden@example.com')],
        replyTo: [address('Maya', 'maya@example.com')]
      }
    })

    const plan = planReply('replyAll', conversation([source]), SELF)

    expect(plan.to).toEqual([address('Maya', 'maya@example.com'), address('Dan', 'dan@example.com')])
    expect(plan.cc).toEqual([address('Priya', 'priya@example.com')])
  })

  it('falls back to the latest self message without addressing self', () => {
    const source = message({
      fromName: 'Me',
      fromEmail: SELF,
      recipients: {
        ...EMPTY_RECIPIENTS,
        to: [address('Maya', 'maya@example.com')]
      }
    })

    expect(planReply('reply', conversation([source]), SELF).to).toEqual([])
    expect(planReply('replyAll', conversation([source]), SELF).to).toEqual([
      address('Maya', 'maya@example.com')
    ])
  })

  it.each<[ReplyKind, string, string]>([
    ['reply', 'Roadmap', 'Re: Roadmap'],
    ['reply', 're: Roadmap', 're: Roadmap'],
    ['reply', 'REPLY: Roadmap', 'REPLY: Roadmap'],
    ['forward', 'Roadmap', 'Fwd: Roadmap'],
    ['forward', 'FW: Roadmap', 'FW: Roadmap'],
    ['forward', 'Forward: Roadmap', 'Forward: Roadmap']
  ])('prefixes %s subject %j once', (kind, subject, expected) => {
    expect(planReply(kind, conversation([message()], subject), SELF).subject).toBe(expected)
  })

  it('returns no threading headers when the cached source predates header storage', () => {
    const plan = planReply(
      'reply',
      conversation([message({ rfcMessageId: null, references: ['<stale@example.com>'] })]),
      SELF
    )

    expect(plan.inReplyTo).toBeNull()
    expect(plan.references).toEqual([])
    expect(plan.threadId).toBe('thread-1')
  })

  it('truncates an oversized References chain from the front and retains the source id', () => {
    const references = Array.from(
      { length: 90 },
      (_, index) => `<${index.toString().padStart(3, '0')}-${'x'.repeat(20)}@example.com>`
    )
    const plan = planReply('reply', conversation([message({ references })]), SELF)

    expect(Buffer.byteLength(`References: ${plan.references.join(' ')}`)).toBeLessThanOrEqual(998)
    expect(plan.references.at(-1)).toBe('<m1@example.com>')
    expect(plan.references[0]).not.toBe(references[0])
  })

  it('quotes sanitized HTML and prefixes every plain-text line', () => {
    const source = message({
      bodyHtml:
        '<p style="color:red" onclick="bad()">Hello <a href="https://example.com" onmouseover="bad()">link</a></p><script>alert(1)</script><img src=x onerror=bad()>',
      bodyText: 'Hello\n\nWorld'
    })
    const plan = planReply('reply', conversation([source]), SELF)

    expect(plan.quoteHtml).toContain(
      '<blockquote><p>Hello <a href="https://example.com">link</a></p></blockquote>'
    )
    expect(plan.quoteHtml).not.toMatch(/script|onclick|onmouseover|onerror|<img/i)
    expect(plan.quoteText).toMatch(/wrote:\n> Hello\n>\n> World$/)
  })

  it('creates a forwarded-message header block without reply threading', () => {
    const source = message({
      recipients: {
        ...EMPTY_RECIPIENTS,
        to: [address('Me', SELF)],
        cc: [address('Priya', 'priya@example.com')]
      }
    })
    const plan = planReply('forward', conversation([source]), SELF)

    expect(plan.to).toEqual([])
    expect(plan.cc).toEqual([])
    expect(plan.threadId).toBeNull()
    expect(plan.inReplyTo).toBeNull()
    expect(plan.references).toEqual([])
    expect(plan.quoteText).toContain('---------- Forwarded message ---------')
    expect(plan.quoteText).toContain('From: Maya Lin <maya@example.com>')
    expect(plan.quoteText).toContain('To: Me <me@example.com>')
    expect(plan.quoteHtml).toContain('Priya &lt;priya@example.com&gt;')
  })

  it('rejects an empty conversation', () => {
    expect(() => planReply('reply', conversation([]), SELF)).toThrow('empty conversation')
  })
})

describe('quote HTML sanitizer', () => {
  it('keeps only the outgoing formatting allowlist and safe link schemes', () => {
    expect(
      sanitizeQuoteHtml(
        '<div class=x>Safe <span>text</span><a href="javascript:alert(1)">bad</a><a href="mailto:a@example.com">mail</a><svg><script>alert(1)</script></svg></div>'
      )
    ).toBe('<div>Safe text<a>bad</a><a href="mailto:a@example.com">mail</a></div>')
  })

  it('does not reconstruct nested or malformed active tags', () => {
    const sanitized = sanitizeQuoteHtml('<scr<script>ipt>alert(1)</scr</script>ipt><p>Kept</p>')
    expect(sanitized).toBe('ipt&gt;alert(1)ipt&gt;<p>Kept</p>')
    expect(sanitized).not.toContain('<script')
  })
})
