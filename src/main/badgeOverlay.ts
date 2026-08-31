// Pure Windows taskbar badge rendering (SPEC F12, M1-PLAN accepted deviation
// closed by M4 T38). Electron-free: the generator emits a raw RGBA bitmap so
// the numerals, the 99+ cap, and the cleared-at-zero rule are unit-testable
// on any OS; notify.ts wraps the pixels in a NativeImage on Windows.

/** Canvas edge in pixels. Rendered at 2x of the 16px overlay slot so the
    numerals stay legible after the taskbar scales the icon down. */
export const BADGE_OVERLAY_SIZE = 32

const GLYPH_WIDTH = 3
const GLYPH_HEIGHT = 5
const GLYPH_SCALE = 2
const GLYPH_SPACING = 2
const PILL_HEIGHT = 22
const PILL_MIN_WIDTH = PILL_HEIGHT

/** Windows badge red, RGBA. */
const BACKGROUND = [217, 48, 37, 255] as const
const FOREGROUND = [255, 255, 255, 255] as const

// 3x5 numerals plus the cap's '+', row-major bit rows.
const GLYPHS: Record<string, readonly number[]> = {
  '0': [0b111, 0b101, 0b101, 0b101, 0b111],
  '1': [0b010, 0b110, 0b010, 0b010, 0b111],
  '2': [0b111, 0b001, 0b111, 0b100, 0b111],
  '3': [0b111, 0b001, 0b111, 0b001, 0b111],
  '4': [0b101, 0b101, 0b111, 0b001, 0b001],
  '5': [0b111, 0b100, 0b111, 0b001, 0b111],
  '6': [0b111, 0b100, 0b111, 0b101, 0b111],
  '7': [0b111, 0b001, 0b001, 0b010, 0b010],
  '8': [0b111, 0b101, 0b111, 0b101, 0b111],
  '9': [0b111, 0b101, 0b111, 0b001, 0b111],
  '+': [0b000, 0b010, 0b111, 0b010, 0b000]
}

export interface BadgeBitmap {
  /** What the numerals spell — `99+` above the cap. */
  text: string
  width: number
  height: number
  /** RGBA, row-major, width*height*4 bytes. */
  pixels: Buffer
}

/** The overlay's caption: exact counts to 99, then the cap. */
export function badgeOverlayText(unreadCount: number): string {
  return unreadCount > 99 ? '99+' : String(unreadCount)
}

/**
 * Render the unread count into a badge bitmap: a centered red pill with white
 * numerals. Zero (or less) returns null — the overlay is cleared, never a
 * blank badge.
 */
export function badgeOverlayBitmap(unreadCount: number): BadgeBitmap | null {
  if (!Number.isFinite(unreadCount) || unreadCount <= 0) return null
  const text = badgeOverlayText(Math.floor(unreadCount))
  const size = BADGE_OVERLAY_SIZE
  const pixels = Buffer.alloc(size * size * 4)

  const textWidth = text.length * GLYPH_WIDTH * GLYPH_SCALE + (text.length - 1) * GLYPH_SPACING
  const textHeight = GLYPH_HEIGHT * GLYPH_SCALE
  const pillWidth = Math.min(size, Math.max(PILL_MIN_WIDTH, textWidth + 8))
  const pillLeft = (size - pillWidth) / 2
  const pillTop = (size - PILL_HEIGHT) / 2
  const radius = PILL_HEIGHT / 2

  const insidePill = (x: number, y: number): boolean => {
    const cx = x + 0.5
    const cy = y + 0.5
    if (cy < pillTop || cy > pillTop + PILL_HEIGHT) return false
    const leftCenter = pillLeft + radius
    const rightCenter = pillLeft + pillWidth - radius
    if (cx >= leftCenter && cx <= rightCenter) return true
    const nearest = cx < leftCenter ? leftCenter : rightCenter
    return (cx - nearest) ** 2 + (cy - (pillTop + radius)) ** 2 <= radius ** 2
  }

  const paint = (x: number, y: number, rgba: readonly [number, number, number, number]): void => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const offset = (y * size + x) * 4
    pixels[offset] = rgba[0]
    pixels[offset + 1] = rgba[1]
    pixels[offset + 2] = rgba[2]
    pixels[offset + 3] = rgba[3]
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (insidePill(x, y)) paint(x, y, BACKGROUND as unknown as [number, number, number, number])
    }
  }

  let penX = Math.round((size - textWidth) / 2)
  const penY = Math.round((size - textHeight) / 2)
  for (const character of text) {
    const glyph = GLYPHS[character]
    if (!glyph) continue
    for (let row = 0; row < GLYPH_HEIGHT; row++) {
      for (let column = 0; column < GLYPH_WIDTH; column++) {
        if (!((glyph[row] >> (GLYPH_WIDTH - 1 - column)) & 1)) continue
        for (let dy = 0; dy < GLYPH_SCALE; dy++) {
          for (let dx = 0; dx < GLYPH_SCALE; dx++) {
            paint(
              penX + column * GLYPH_SCALE + dx,
              penY + row * GLYPH_SCALE + dy,
              FOREGROUND as unknown as [number, number, number, number]
            )
          }
        }
      }
    }
    penX += GLYPH_WIDTH * GLYPH_SCALE + GLYPH_SPACING
  }

  return { text, width: size, height: size, pixels }
}
