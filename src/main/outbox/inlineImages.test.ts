import { describe, expect, it } from 'vitest'
import { isSupportedInlineImageMimeType } from './inlineImages'

describe('inline image MIME allowlist', () => {
  it('allows only image formats safe on both reader and composer bridges', () => {
    for (const mimeType of ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'IMAGE/PNG']) {
      expect(isSupportedInlineImageMimeType(mimeType)).toBe(true)
    }
    for (const mimeType of ['image/svg+xml', 'image/bmp', 'text/html', 'image/png; charset=utf-8']) {
      expect(isSupportedInlineImageMimeType(mimeType)).toBe(false)
    }
  })
})
