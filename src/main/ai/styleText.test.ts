import { describe, expect, it } from 'vitest'
import { STYLE_EXAMPLE_MAX_INPUT_BYTES, styleExampleText } from './styleText'

describe('styleExampleText', () => {
  it('rejects oversized raw inputs before cleanup, without falling back from HTML to plain text', () => {
    const largeQuote = `<blockquote>${'q'.repeat(STYLE_EXAMPLE_MAX_INPUT_BYTES)}</blockquote>`
    expect(styleExampleText('Unsafe alternative', `<p>My answer.</p>${largeQuote}`)).toBe('')
    expect(styleExampleText(`${' '.repeat(STYLE_EXAMPLE_MAX_INPUT_BYTES)}Answer.`, null)).toBe('')
    // Count UTF-8 bytes across both alternatives, not characters or each part separately.
    expect(styleExampleText('é'.repeat(STYLE_EXAMPLE_MAX_INPUT_BYTES / 2), null)).toHaveLength(
      STYLE_EXAMPLE_MAX_INPUT_BYTES / 2
    )
    expect(styleExampleText('é'.repeat(STYLE_EXAMPLE_MAX_INPUT_BYTES / 2), 'x')).toBe('')
    expect(
      styleExampleText(
        'x'.repeat(STYLE_EXAMPLE_MAX_INPUT_BYTES / 2),
        'x'.repeat(STYLE_EXAMPLE_MAX_INPUT_BYTES / 2 + 1)
      )
    ).toBe('')
  })

  it.each([
    'On Tuesday, Maya wrote:\nSomeone else’s words.',
    'On Tuesday, September 1, 2026,\nMaya <maya@example.com>\nwrote:\nSomeone else’s words.',
    '---------- Forwarded message ---------\nFrom: Maya\nSomeone else’s words.',
    '-----Original Message-----\nSomeone else’s words.',
    'Begin forwarded message:\nSomeone else’s words.',
    'From: Maya <maya@example.com>\nSent: Tuesday\nTo: Me\nSubject: Review\nSomeone else’s words.',
    '-- \nMy signature\nCompany details',
    '-- The Support Team --\nCompany details',
    'Sent from my iPhone',
    'Get Outlook for Android',
    'Sent with Attn',
    'Sent with Attn:'
  ])('removes a plain-text trail starting with %s', (trail) => {
    expect(styleExampleText(`My own answer.\r\n\r\n${trail}`, null)).toBe('My own answer.')
  })

  it('removes quoted lines while preserving inline answers and paragraph breaks', () => {
    expect(styleExampleText('  > A question\nMy answer.\n\n>> Another question\nAnother answer.', null)).toBe(
      'My answer.\n\nAnother answer.'
    )
    expect(styleExampleText('> Only quoted text', null)).toBe('')
    expect(styleExampleText('On Monday I can help.\nThanks,\nAlex', null)).toBe(
      'On Monday I can help.\nThanks,\nAlex'
    )
  })

  it.each([
    '<blockquote type="cite">Other writing</blockquote>',
    '<div class="gmail_quote"><div class="gmail_attr">On Tuesday, Maya wrote:</div>Other writing</div>',
    '<div class="yahoo_quoted">Other writing</div>',
    '<div class="protonmail_quote">Other writing</div>',
    '<div class="gmail_signature_prefix">-- </div><div class="gmail_signature">My signature</div>',
    '<div class="moz-signature">My signature</div>',
    '<div id="AppleMailSignature">My signature</div>',
    '<div id="Signature">My signature</div>',
    '<div data-attn-signature="footer">Sent with Attn</div>',
    '<div data-attn-signature="footer">Sent with Attn:</div>'
  ])('removes structural HTML quotes and signatures: %s', (excluded) => {
    expect(styleExampleText('Flattened copy contains other writing.', `<p>My answer.</p>${excluded}`)).toBe(
      'My answer.'
    )
    expect(styleExampleText('Unsafe fallback text', excluded)).toBe('')
  })

  it('preserves HTML inline answers and decodes entities without retaining scripts or metadata', () => {
    expect(
      styleExampleText(
        null,
        '<style>private CSS</style><script>private script</script><p>My <b>answer</b> &amp; thoughts.<br>Next line.</p>' +
          '<blockquote>Someone else’s words.</blockquote><p>My second answer.</p><div hidden>Hidden text</div>'
      )
    ).toBe('My answer & thoughts.\nNext line.\n\nMy second answer.')
  })

  it('stops at the Outlook HTML header even when the quoted body is outside the header', () => {
    expect(
      styleExampleText(
        null,
        '<div><p>My answer.</p><div id="divRplyFwdMsg">From: Maya</div><p>Other writing</p></div>'
      )
    ).toBe('My answer.')
  })
})
