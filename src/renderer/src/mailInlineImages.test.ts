import { describe, expect, it } from 'vitest'
import type { MessageAttachment } from '../../shared/mail'
import { matchInlineImageReferences, normalizedContentId } from './mailInlineImages'

function image(attachmentId: string, filename: string, contentId?: string): MessageAttachment {
  return {
    attachmentId,
    filename,
    mimeType: 'image/png',
    sizeBytes: 35,
    ...(contentId ? { contentId } : {})
  }
}

describe('inline mail image matching', () => {
  it('normalizes encoded and bracketed content ids', () => {
    expect(normalizedContentId('%3CImage-ID%40Example.test%3E')).toBe('image-id@example.test')
  })

  it('matches direct content ids before sender-supplied filename aliases', () => {
    const direct = image('direct', 'other.png', 'image.png')
    const filenameAlias = image('alias', 'image.png', 'generated@example.test')
    expect(matchInlineImageReferences([direct, filenameAlias], [{ contentId: 'image.png' }])).toEqual([
      { attachment: direct, contentIds: ['image.png'] }
    ])
  })

  it('uses a unique CID filename when HTML and MIME content ids disagree', () => {
    const attachment = image('alias', 'image.png', 'generated@example.test')
    expect(matchInlineImageReferences([attachment], [{ contentId: 'image.png' }])).toEqual([
      { attachment, contentIds: ['image.png'] }
    ])
  })

  it('uses a unique alt filename when the HTML CID is also generated', () => {
    const attachment = image('alias', 'image.png', 'mime-generated@example.test')
    expect(
      matchInlineImageReferences(
        [attachment],
        [{ contentId: 'html-generated@example.test', filenameHint: 'image.png' }]
      )
    ).toEqual([{ attachment, contentIds: ['html-generated@example.test'] }])
  })

  it('does not choose an alt filename when duplicate references disagree', () => {
    const first = image('first', 'first.png', 'first@example.test')
    const second = image('second', 'second.png', 'second@example.test')
    expect(
      matchInlineImageReferences(
        [first, second],
        [
          { contentId: 'html-generated@example.test', filenameHint: 'first.png' },
          { contentId: 'html-generated@example.test', filenameHint: 'second.png' }
        ]
      )
    ).toEqual([])
  })

  it('does not guess between duplicate filenames or unsafe image types', () => {
    const first = image('first', 'image.png', 'first@example.test')
    const second = image('second', 'image.png', 'second@example.test')
    const svg = { ...image('svg', 'vector.svg'), mimeType: 'image/svg+xml' }
    expect(
      matchInlineImageReferences(
        [first, second, svg],
        [{ contentId: 'unknown', filenameHint: 'image.png' }, { contentId: 'vector.svg' }]
      )
    ).toEqual([])
  })
})
