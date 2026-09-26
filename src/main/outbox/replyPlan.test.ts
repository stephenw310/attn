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
    bodyState: 'complete',
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

    expect(planReply('reply', conversation([source]), SELF).to).toEqual([address('Maya', 'maya@example.com')])
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

    expect(plan.quoteHtml).toContain('<p style="color:red">Hello <a href="https://example.com">link</a></p>')
    expect(plan.quoteHtml).toContain('<img src="x">')
    expect(plan.quoteHtml).not.toMatch(/script|onclick|onmouseover|onerror/i)
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
    expect(plan.threadId).toBe('thread-1')
    expect(plan.inReplyTo).toBeNull()
    expect(plan.references).toEqual([])
    expect(plan.quoteText).toContain('---------- Forwarded message ---------')
    expect(plan.quoteText).toContain('From: Maya Lin <maya@example.com>')
    expect(plan.quoteText).toContain('To: Me <me@example.com>')
    expect(plan.quoteHtml).toContain('Priya &lt;priya@example.com&gt;')
  })

  it('forwards the newest message even when it was sent by self', () => {
    const inbound = message()
    const latestSelf = message({
      id: 'm2',
      fromName: 'Me',
      fromEmail: SELF,
      at: inbound.at + 1_000,
      bodyText: 'My latest update',
      bodyHtml: '<p>My latest update</p>'
    })

    const plan = planReply('forward', conversation([inbound, latestSelf]), SELF)

    expect(plan.quoteText).toContain('From: Me <me@example.com>')
    expect(plan.quoteText).toContain('My latest update')
    expect(plan.quoteText).not.toContain('From: Maya Lin <maya@example.com>')
  })

  it('rejects an empty conversation', () => {
    expect(() => planReply('reply', conversation([]), SELF)).toThrow('empty conversation')
  })

  it.each<ReplyKind>(['reply', 'replyAll', 'forward'])('targets an earlier message for %s', (kind) => {
    const original = message({
      recipients: {
        ...EMPTY_RECIPIENTS,
        to: [address('Me', SELF)],
        cc: [address('Priya', 'priya@example.com')],
        replyTo: [address('Original replies', 'original-replies@example.com')]
      }
    })
    const colleague = message({
      id: 'colleague-message',
      at: original.at + 1_000,
      fromEmail: 'colleague@example.com',
      rfcMessageId: '<colleague@example.com>',
      bodyText: 'Private side conversation',
      bodyHtml: '<p>Private side conversation</p>'
    })
    const plan = planReply(kind, conversation([original, colleague]), SELF, original.id)
    expect(plan.sourceMessageId).toBe(original.id)
    expect(plan.quoteText).toContain(original.bodyText.split('\n')[0])
    expect(plan.quoteHtml).not.toContain('Private side conversation')
    expect(plan.to).toEqual(
      kind === 'forward' ? [] : [address('Original replies', 'original-replies@example.com')]
    )
    expect(plan.cc).toEqual(kind === 'replyAll' ? [address('Priya', 'priya@example.com')] : [])
    expect(plan.inReplyTo).toBe(kind === 'forward' ? null : original.rfcMessageId)
    expect(plan.references).toEqual(kind === 'forward' ? [] : [...original.references, original.rfcMessageId])
  })

  it('never falls back to the newest message when an explicit source is unavailable', () => {
    expect(() => planReply('reply', conversation([message()]), SELF, 'different-thread-message')).toThrow(
      'Source message is unavailable'
    )
  })
})

describe('quote HTML sanitizer', () => {
  it('uses the display DOMPurify policy and removes active content', () => {
    const sanitized = sanitizeQuoteHtml(
      '<div class=x>Safe <span>text</span><a href="javascript:alert(1)">bad</a><a href="mailto:a@example.com">mail</a><svg><script>alert(1)</script></svg></div>'
    )

    expect(sanitized).toBe(
      '<div class="x">Safe <span>text</span><a>bad</a><a href="mailto:a@example.com">mail</a><svg></svg></div>'
    )
  })

  it('does not reconstruct nested or malformed active tags', () => {
    const sanitized = sanitizeQuoteHtml('<scr<script>ipt>alert(1)</scr</script>ipt><p>Kept</p>')
    expect(sanitized).toBe('ipt&gt;alert(1)ipt&gt;<p>Kept</p>')
    expect(sanitized).not.toContain('<script')
  })

  it('preserves content after void and malformed forbidden elements', () => {
    expect(sanitizeQuoteHtml('<p>Before</p><img src="cid:image"><p>After the image</p><p>More</p>')).toBe(
      '<p>Before</p><img src="cid:image"><p>After the image</p><p>More</p>'
    )

    const malformed = sanitizeQuoteHtml('<svg><style></svg></style><p>After malformed nesting</p>')
    expect(malformed).toContain('<p>After malformed nesting</p>')
  })

  it('strips sender styles before embedding quoted HTML into an outgoing document', () => {
    const source = message({
      bodyText: 'Please pay.',
      bodyHtml: '<style>body{display:none !important}</style><p>Please pay.</p>'
    })

    const plan = planReply('reply', conversation([source]), SELF)

    expect(plan.quoteHtml).toContain('<blockquote><p>Please pay.</p></blockquote>')
    expect(plan.quoteHtml).not.toMatch(/<style|display\s*:\s*none/i)
  })

  it('strips inline positioning so a quote cannot cover the authored reply', () => {
    const source = message({
      bodyText: 'Please pay.',
      bodyHtml:
        '<div style="position:fixed;inset:0;background:white;z-index:9999">OVERLAY</div><p style="color:red">Please pay.</p>'
    })

    const plan = planReply('reply', conversation([source]), SELF)

    expect(plan.quoteHtml).not.toMatch(/position|z-index|inset/i)
    // The harmless half of the same declaration survives, as does authored colour.
    expect(plan.quoteHtml).toContain('<div style="background:white">OVERLAY</div>')
    expect(plan.quoteHtml).toContain('<p style="color:red">Please pay.</p>')
  })

  it('strips CSS-escaped positioning and custom-property references from a quote', () => {
    const source = message({
      bodyText: 'Please pay.',
      bodyHtml:
        '<div style="tr\\61nslate:0 -900px;color:red">ESCAPED POSITION</div>' +
        '<div style="--m:-600px;margin-top:v\\61r(--m);padding:8px">ESCAPED VARIABLE</div>'
    })

    const plan = planReply('reply', conversation([source]), SELF)

    expect(plan.quoteHtml).toContain('<div style="color:red">ESCAPED POSITION</div>')
    expect(plan.quoteHtml).toContain('<div style="--m:-600px; padding:8px">ESCAPED VARIABLE</div>')
    expect(plan.quoteHtml).not.toContain('\\61')
  })

  it('drops document metadata that a full-page mail body carries into the quote', () => {
    const source = message({
      bodyText: 'Real body',
      bodyHtml: '<html><head><title>Newsletter Title</title></head><body><p>Real body</p></body></html>'
    })

    const plan = planReply('reply', conversation([source]), SELF)

    expect(plan.quoteHtml).toContain('<blockquote><p>Real body</p></blockquote>')
    expect(plan.quoteHtml).not.toMatch(/<title|Newsletter Title/i)
  })

  it('reads href from the parsed attribute instead of attribute text', () => {
    expect(
      sanitizeQuoteHtml('<a title="see href=https://evil.example" href="https://real.example">click</a>')
    ).toBe('<a title="see href=https://evil.example" href="https://real.example">click</a>')
  })

  it('preserves document and table structure instead of flattening text', () => {
    const sanitized = sanitizeQuoteHtml(
      '<html><head><title>Newsletter Title</title></head><body><table><tr><td>Cell A</td><td>Cell B</td></tr></table><p>Real body</p></body></html>'
    )

    expect(sanitized).toContain('<table><tbody><tr><td>Cell A</td><td>Cell B</td></tr></tbody></table>')
    expect(sanitized).toContain('<p>Real body</p>')
    expect(sanitized).not.toContain('Cell ACell B')
  })
})

it('treats verified send-as addresses as self when choosing a reply source and recipients', () => {
  const alias = 'work@example.org'
  const source = message({
    recipients: {
      ...EMPTY_RECIPIENTS,
      to: [address('Work', alias), address('Me', SELF)],
      cc: [address('Other', 'other@example.com')]
    }
  })
  const sent = message({ id: 'sent', fromEmail: alias, at: source.at + 1000 })
  const plan = planReply('replyAll', conversation([source, sent]), SELF, undefined, [alias])
  expect(plan.sourceMessageId).toBe(source.id)
  expect(plan.to.map((item) => item.email)).toEqual(['maya@example.com'])
  expect(plan.cc.map((item) => item.email)).toEqual(['other@example.com'])
})

describe('reply sender identity', () => {
  const alias = 'work@example.org'
  it.each<ReplyKind>(['reply', 'replyAll', 'forward'])('matches received aliases for %s', (kind) => {
    const source = message({ recipients: { ...EMPTY_RECIPIENTS, to: [address('', 'WORK@example.org')] } })
    expect(planReply(kind, conversation([source]), SELF, undefined, [alias]).senderEmail).toBe(alias)
  })

  it.each<ReplyKind>(['reply', 'replyAll', 'forward'])('preserves an owned From for %s', (kind) => {
    const source = message({ fromEmail: alias, recipients: { ...EMPTY_RECIPIENTS, to: [address('', SELF)] } })
    expect(planReply(kind, conversation([source]), SELF, source.id, [alias]).senderEmail).toBe(alias)
  })

  it('prefers To over Cc and Bcc, then uses their first matching address', () => {
    const source = message({
      recipients: {
        to: [address('', SELF)],
        cc: [address('', alias)],
        bcc: [address('', 'hidden@example.org')],
        replyTo: []
      }
    })
    const aliases = [alias, 'hidden@example.org']
    expect(planReply('reply', conversation([source]), SELF, undefined, aliases).senderEmail).toBe(SELF)
    source.recipients.to = []
    expect(planReply('reply', conversation([source]), SELF, undefined, aliases).senderEmail).toBe(alias)
    source.recipients.cc = []
    expect(planReply('reply', conversation([source]), SELF, undefined, aliases).senderEmail).toBe(
      'hidden@example.org'
    )
  })

  it('leaves unmatched identities to the default and ignores Reply-To for sender selection', () => {
    const source = message({
      recipients: { ...EMPTY_RECIPIENTS, to: [address('', alias)], replyTo: [address('', SELF)] }
    })
    expect(planReply('reply', conversation([source]), SELF).senderEmail).toBeUndefined()
  })

  it('uses the selected source instead of an identity elsewhere in the thread', () => {
    const older = message({ recipients: { ...EMPTY_RECIPIENTS, to: [address('', alias)] } })
    const newer = message({
      id: 'newer',
      at: older.at + 1000,
      recipients: { ...EMPTY_RECIPIENTS, to: [address('', SELF)] }
    })
    expect(planReply('reply', conversation([older, newer]), SELF, older.id, [alias]).senderEmail).toBe(alias)
    expect(planReply('reply', conversation([older, newer]), SELF, undefined, [alias]).senderEmail).toBe(SELF)
  })
})
