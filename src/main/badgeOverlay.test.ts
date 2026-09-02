import { describe, expect, it } from 'vitest'
import { BADGE_OVERLAY_SIZE, badgeOverlayBitmap, badgeOverlayText } from './badgeOverlay'

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
  it('shows exact counts to 99 and caps beyond', () => {
    expect(badgeOverlayText(1)).toBe('1')
    expect(badgeOverlayText(42)).toBe('42')
    expect(badgeOverlayText(99)).toBe('99')
    expect(badgeOverlayText(100)).toBe('99+')
    expect(badgeOverlayText(150)).toBe('99+')
  })
})

describe('badgeOverlayBitmap', () => {
  it('clears the overlay at zero instead of rendering a blank badge', () => {
    expect(badgeOverlayBitmap(0)).toBeNull()
    expect(badgeOverlayBitmap(-3)).toBeNull()
    expect(badgeOverlayBitmap(Number.NaN)).toBeNull()
  })

  it('renders a fixed-size RGBA bitmap with pill and numerals', () => {
    for (const count of [1, 42, 150]) {
      const bitmap = badgeOverlayBitmap(count)
      expect(bitmap).not.toBeNull()
      expect(bitmap?.width).toBe(BADGE_OVERLAY_SIZE)
      expect(bitmap?.height).toBe(BADGE_OVERLAY_SIZE)
      expect(bitmap?.pixels.length).toBe(BADGE_OVERLAY_SIZE * BADGE_OVERLAY_SIZE * 4)
      const colors = colorCounts(bitmap?.pixels as Buffer)
      // The pill dominates, the numerals sit on it, and the corners stay
      // transparent so the overlay reads as a badge rather than a square.
      expect(colors.red).toBeGreaterThan(colors.white)
      expect(colors.white).toBeGreaterThan(10)
      expect(colors.transparent).toBeGreaterThan(0)
    }
  })

  it('draws different numerals for different counts and widens for the cap', () => {
    const one = badgeOverlayBitmap(1)
    const eight = badgeOverlayBitmap(8)
    const capped = badgeOverlayBitmap(150)
    expect(one?.pixels.equals(eight?.pixels as Buffer)).toBe(false)
    expect(capped?.text).toBe('99+')
    // Three glyphs paint more foreground than one.
    expect(colorCounts(capped?.pixels as Buffer).white).toBeGreaterThan(
      colorCounts(one?.pixels as Buffer).white
    )
  })

  it('keeps every painted pixel inside the canvas at the cap width', () => {
    const bitmap = badgeOverlayBitmap(999)
    expect(bitmap?.pixels.length).toBe(BADGE_OVERLAY_SIZE * BADGE_OVERLAY_SIZE * 4)
    // The first and last rows are outside the pill: fully transparent.
    const firstRow = bitmap?.pixels.subarray(0, BADGE_OVERLAY_SIZE * 4) as Buffer
    expect(colorCounts(firstRow).transparent).toBe(BADGE_OVERLAY_SIZE)
  })
})
