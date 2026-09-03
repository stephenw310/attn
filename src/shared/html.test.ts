import { describe, expect, it } from 'vitest'
import { escapeHtmlText, safeUrl } from './html'

describe('escapeHtmlText', () => {
  it('escapes the three text-node entities and nothing else', () => {
    expect(escapeHtmlText('a & b < c > d "e" \'f\'')).toBe('a &amp; b &lt; c &gt; d "e" \'f\'')
  })
})

describe('safeUrl', () => {
  it('admits only the schemes its caller names', () => {
    expect(safeUrl('https://example.com/a?b#c', ['http', 'https'])).toBe('https://example.com/a?b#c')
    expect(safeUrl('mailto:a@example.com', ['http', 'https', 'mailto'])).toBe('mailto:a@example.com')
    expect(safeUrl('mailto:a@example.com', ['http', 'https'])).toBeNull()
    expect(safeUrl('javascript:alert(1)', ['http', 'https', 'mailto'])).toBeNull()
    expect(safeUrl('data:text/html,<b>', ['http', 'https'])).toBeNull()
  })

  it('reads the scheme the way the browser does, not the way the text looks', () => {
    // Chromium ignores ASCII whitespace inside a scheme, so a prefix test would
    // miss this while the frame would still navigate.
    expect(safeUrl('java\nscript:alert(1)', ['http', 'https'])).toBeNull()
    expect(safeUrl('  HTTPS://example.com  ', ['https'])).toBe('HTTPS://example.com')
  })

  it('refuses a relative value unless a base opts into resolving it', () => {
    expect(safeUrl('/tracker.gif', ['http', 'https'])).toBeNull()
    expect(safeUrl('/tracker.gif', ['http', 'https'], 'https://mail.example/read')).toBe('/tracker.gif')
    expect(safeUrl('/tracker.gif', ['http', 'https'], 'file:///app/index.html')).toBeNull()
    expect(safeUrl('', ['http', 'https'], 'https://mail.example/read')).toBeNull()
  })
})
