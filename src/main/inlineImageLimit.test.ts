import { describe, expect, it } from 'vitest'
import { inlineImageIsTooLarge, MAX_INLINE_IMAGE_BYTES } from './inlineImageLimit'

describe('inline image display limit', () => {
  it('accepts 25 MiB and rejects the next byte', () => {
    expect(MAX_INLINE_IMAGE_BYTES).toBe(25 * 1024 * 1024)
    expect(inlineImageIsTooLarge(MAX_INLINE_IMAGE_BYTES)).toBe(false)
    expect(inlineImageIsTooLarge(MAX_INLINE_IMAGE_BYTES + 1)).toBe(true)
  })
})
