import { describe, expect, it } from 'vitest'
import { BADGE_OVERLAY_SIZE, badgeOverlayBitmap, badgeOverlayPng, badgeOverlayText } from './badgeOverlay'

function colorCounts(pixels: Buffer): { red: number; white: number; transparent: number } {
  let red = 0
  let white = 0
  let transparent = 0
  for (let offset = 0; offset < pixels.length; offset += 4) {
    if (pixels[offset + 3] === 0) transparent++
    else if (pixels[offset] === 255 && pixels[offset + 1] === 255 && pixels[offset + 2] === 255) white++
    else red++
  }
  return { red, white, transparent }
}

describe('badgeOverlayText', () => {
  it('keeps one-digit labels large and caps higher counts at 9+', () => {
    expect(badgeOverlayText(1)).toBe('1')
    expect(badgeOverlayText(9)).toBe('9')
    expect(badgeOverlayText(10)).toBe('9+')
    expect(badgeOverlayText(1_500)).toBe('9+')
  })
})

describe('badgeOverlayBitmap', () => {
  it('clears the overlay at zero instead of rendering a blank badge', () => {
    expect(badgeOverlayBitmap(0)).toBeNull()
    expect(badgeOverlayBitmap(-3)).toBeNull()
    expect(badgeOverlayBitmap(Number.NaN)).toBeNull()
  })

  it('fills the overlay with a large red circle and readable white label', () => {
    for (const count of [1, 9, 10]) {
      const bitmap = badgeOverlayBitmap(count)
      expect(bitmap?.width).toBe(BADGE_OVERLAY_SIZE)
      expect(bitmap?.height).toBe(BADGE_OVERLAY_SIZE)
      expect(bitmap?.pixels.length).toBe(BADGE_OVERLAY_SIZE * BADGE_OVERLAY_SIZE * 4)
      const colors = colorCounts(bitmap?.pixels as Buffer)
      expect(colors.red).toBeGreaterThan(500)
      expect(colors.white).toBeGreaterThan(20)
      expect(colors.transparent).toBeGreaterThan(0)
    }
  })

  it('draws different numerals while reusing the capped label', () => {
    const one = badgeOverlayBitmap(1)
    const eight = badgeOverlayBitmap(8)
    const capped = badgeOverlayBitmap(150)
    expect(one?.pixels.equals(eight?.pixels as Buffer)).toBe(false)
    expect(capped?.text).toBe('9+')
    expect(colorCounts(capped?.pixels as Buffer).white).toBeGreaterThan(
      colorCounts(one?.pixels as Buffer).white
    )
  })
})

describe('badgeOverlayPng', () => {
  it('encodes a valid 32px PNG per visible label', () => {
    const one = badgeOverlayPng(1)
    const eight = badgeOverlayPng(8)
    const ten = badgeOverlayPng(10)
    const many = badgeOverlayPng(1_500)
    expect(one?.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    expect(one?.readUInt32BE(16)).toBe(BADGE_OVERLAY_SIZE)
    expect(one?.readUInt32BE(20)).toBe(BADGE_OVERLAY_SIZE)
    expect(one?.equals(eight as Buffer)).toBe(false)
    // Everything above nine shares the `9+` label, so it encodes identically.
    expect(ten?.equals(many as Buffer)).toBe(true)
  })
})
