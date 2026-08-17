import { describe, expect, it } from 'vitest'
import { draftHtmlBody } from './draftMime'
import { splitQuotedTrail } from './quoteSplit'

const ATTN_REPLY =
  '<div>my answer</div>\n<div>On Sun, 16 Aug 2026 14:33:17 GMT, AlphaSignal &lt;news@alphasignal.ai&gt; wrote:</div><blockquote><table width="600"><tr><td>Newsletter</td></tr></table></blockquote>'

describe('recovering a quoted trail from a round-tripped draft', () => {
  it("splits Attn's own reply shape at the attribution line", () => {
    const split = splitQuotedTrail(ATTN_REPLY, 'my answer\nOn Sun, 16 Aug 2026 wrote:\n> Newsletter')

    expect(split.bodyHtml).toBe('<div>my answer</div>')
    expect(split.quoteHtml).toContain('wrote:')
    expect(split.quoteHtml).toContain('<blockquote>')
    expect(split.bodyText).toBe('my answer')
    expect(split.quoteText).toContain('wrote:')
  })

  it('is a fixed point across reassembly, so sync cannot loop', () => {
    // The mirror sends `draftHtmlBody(...)`, and the next read splits it again.
    // If the two disagreed, every sync would report a remote change.
    const once = splitQuotedTrail(ATTN_REPLY, 'my answer')
    const reassembled = draftHtmlBody({ bodyHtml: once.bodyHtml, bodyText: '', quoteHtml: once.quoteHtml })
    const twice = splitQuotedTrail(reassembled, 'my answer')

    expect(twice.bodyHtml).toBe(once.bodyHtml)
    expect(twice.quoteHtml).toBe(once.quoteHtml)
    expect(draftHtmlBody({ bodyHtml: twice.bodyHtml, bodyText: '', quoteHtml: twice.quoteHtml })).toBe(
      reassembled
    )
  })

  it('splits a Gmail-authored quote container', () => {
    const html =
      '<div>thanks</div><div class="gmail_quote gmail_quote_container"><div class="gmail_attr">On Mon someone wrote:</div><blockquote>Original</blockquote></div>'
    const split = splitQuotedTrail(html, '')

    expect(split.bodyHtml).toBe('<div>thanks</div>')
    expect(split.quoteHtml).toContain('gmail_quote')
  })

  it('keeps everything in the body when the author typed below the quote', () => {
    // Reassembly always appends the quote last, so splitting here would move
    // the trailing sentence above the quoted text.
    const html = `${ATTN_REPLY}<div>one more thing</div>`
    const split = splitQuotedTrail(html, 'body')

    expect(split.bodyHtml).toBe(html)
    expect(split.quoteHtml).toBe('')
  })

  it('splits past trailing whitespace rather than giving up', () => {
    const split = splitQuotedTrail(`${ATTN_REPLY}\n  \n`, '')
    expect(split.bodyHtml).toBe('<div>my answer</div>')
    expect(split.quoteHtml).toContain('<blockquote>')
  })

  it('leaves a draft that has no quoted trail untouched', () => {
    const html = '<div>just a note</div>'
    expect(splitQuotedTrail(html, 'just a note')).toEqual({
      bodyHtml: html,
      quoteHtml: '',
      bodyText: 'just a note',
      quoteText: ''
    })
  })

  it('does not split a quote the author opened the draft with', () => {
    // No authored content precedes it, so there is nothing to separate.
    const split = splitQuotedTrail('<blockquote>Pasted quote</blockquote>', '')
    expect(split.quoteHtml).toBe('')
  })

  it('leaves the text merged when no attribution line is recognizable', () => {
    const split = splitQuotedTrail(ATTN_REPLY, 'my answer\n> Newsletter')
    expect(split.bodyText).toBe('my answer\n> Newsletter')
    expect(split.quoteText).toBe('')
  })
})
