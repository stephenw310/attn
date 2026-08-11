import { describe, expect, it } from 'vitest'
import { mergeExternalBodies } from './mergeBodies'

describe('mergeExternalBodies', () => {
  it('preserves authored inline plain text when the HTML alternative is external', () => {
    expect(
      mergeExternalBodies({
        storedText: 'Flight AA123 · SFO → JFK',
        storedHtml: null,
        inlineText: 'Flight AA123 · SFO → JFK',
        hasInlinePlain: true,
        fetchedPlain: [],
        fetchedHtml: ['<p>Flight AA123 &middot; SFO &rarr; JFK</p>']
      })
    ).toEqual({
      bodyText: 'Flight AA123 · SFO → JFK',
      bodyHtml: '<p>Flight AA123 &middot; SFO &rarr; JFK</p>'
    })
  })

  it('replaces an HTML-derived inline fallback with fetched plain text without duplicating it', () => {
    expect(
      mergeExternalBodies({
        storedText: 'Boarding at 10:30',
        storedHtml: '<p>Boarding at 10:30</p>',
        inlineText: 'Boarding at 10:30',
        hasInlinePlain: false,
        fetchedPlain: ['Boarding at 10:30'],
        fetchedHtml: []
      })
    ).toEqual({
      bodyText: 'Boarding at 10:30',
      bodyHtml: '<p>Boarding at 10:30</p>'
    })
  })

  it('joins genuinely separate inline and external plain-text parts', () => {
    expect(
      mergeExternalBodies({
        storedText: 'Introduction',
        storedHtml: null,
        inlineText: 'Introduction',
        hasInlinePlain: true,
        fetchedPlain: ['Details'],
        fetchedHtml: []
      })
    ).toEqual({ bodyText: 'Introduction\n\nDetails', bodyHtml: null })
  })

  it('derives a text fallback from fetched HTML only when no stored text exists', () => {
    expect(
      mergeExternalBodies({
        storedText: '',
        storedHtml: null,
        inlineText: '',
        hasInlinePlain: false,
        fetchedPlain: [],
        fetchedHtml: ['<p>External details</p>']
      })
    ).toEqual({ bodyText: 'External details', bodyHtml: '<p>External details</p>' })
  })
})
