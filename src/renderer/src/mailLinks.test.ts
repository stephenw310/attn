// @vitest-environment jsdom

import { describe, expect, it } from 'vitest'
import { linkifyBareMailUrls, mailTextParts } from './mailLinks'

describe('mail linkification', () => {
  it('links HTTP(S) and www URLs without swallowing sentence punctuation', () => {
    expect(
      mailTextParts(
        'Open https://stokes.example/PAL/Melphalan.pdf, then (http://example.test/meddrop). Visit www.example.test too.'
      )
    ).toEqual([
      { text: 'Open ' },
      {
        text: 'https://stokes.example/PAL/Melphalan.pdf',
        href: 'https://stokes.example/PAL/Melphalan.pdf'
      },
      { text: ', then (' },
      { text: 'http://example.test/meddrop', href: 'http://example.test/meddrop' },
      { text: '). Visit ' },
      { text: 'www.example.test', href: 'https://www.example.test' },
      { text: ' too.' }
    ])
  })

  it('keeps balanced closing punctuation that belongs to a URL', () => {
    expect(mailTextParts('See https://en.example.test/wiki/Function_(math).')).toEqual([
      { text: 'See ' },
      {
        text: 'https://en.example.test/wiki/Function_(math)',
        href: 'https://en.example.test/wiki/Function_(math)'
      },
      { text: '.' }
    ])
  })

  it('does not link URL-like substrings inside email addresses or words', () => {
    expect(mailTextParts('Write foo@www.example.test or prefixhttps://example.test.')).toEqual([
      { text: 'Write foo@www.example.test or prefixhttps://example.test.' }
    ])
  })

  it('adds safe anchors to text nodes and leaves existing anchors alone', () => {
    const template = document.createElement('template')
    template.innerHTML =
      '<div>Click https://bare.example/path.</div><a href="https://linked.example">www.linked.example</a><style>.x{content:"https://style.example"}</style>'

    linkifyBareMailUrls(template.content)

    const links = [...template.content.querySelectorAll('a')]
    expect(links).toHaveLength(2)
    expect(links[0]?.outerHTML).toBe(
      '<a href="https://bare.example/path" target="_blank" rel="noopener noreferrer">https://bare.example/path</a>'
    )
    expect(links[1]?.outerHTML).toBe('<a href="https://linked.example">www.linked.example</a>')
    expect(template.content.querySelector('style')?.textContent).toContain('https://style.example')
  })
})
