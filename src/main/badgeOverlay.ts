import { deflateSync } from 'node:zlib'

// Windows gives an app a fixed 16px taskbar-overlay slot. Render at 2x so a
// large circle and short label survive taskbar scaling, then hand Electron a
// PNG so its decoder cannot reinterpret RGBA channels on Windows.

export const BADGE_OVERLAY_SIZE = 32

const GLYPH_WIDTH = 5
const GLYPH_HEIGHT = 7
const SINGLE_GLYPH_SCALE = 3
const MULTI_GLYPH_SCALE = 2
const MULTI_GLYPH_SPACING = 2
const CIRCLE_RADIUS = 15

/** Slack-like notification red, RGBA. */
const BACKGROUND = [224, 30, 90, 255] as const
const FOREGROUND = [255, 255, 255, 255] as const

// 5x7 numerals plus the cap's '+', row-major bit rows.
const GLYPHS: Record<string, readonly number[]> = {
  '0': [0b01110, 0b10001, 0b10011, 0b10101, 0b11001, 0b10001, 0b01110],
  '1': [0b00100, 0b01100, 0b00100, 0b00100, 0b00100, 0b00100, 0b01110],
  '2': [0b01110, 0b10001, 0b00001, 0b00010, 0b00100, 0b01000, 0b11111],
  '3': [0b11110, 0b00001, 0b00001, 0b01110, 0b00001, 0b00001, 0b11110],
  '4': [0b00010, 0b00110, 0b01010, 0b10010, 0b11111, 0b00010, 0b00010],
  '5': [0b11111, 0b10000, 0b10000, 0b11110, 0b00001, 0b00001, 0b11110],
  '6': [0b01110, 0b10000, 0b10000, 0b11110, 0b10001, 0b10001, 0b01110],
  '7': [0b11111, 0b00001, 0b00010, 0b00100, 0b01000, 0b01000, 0b01000],
  '8': [0b01110, 0b10001, 0b10001, 0b01110, 0b10001, 0b10001, 0b01110],
  '9': [0b01110, 0b10001, 0b10001, 0b01111, 0b00001, 0b00001, 0b01110],
  '+': [0b00000, 0b00100, 0b00100, 0b11111, 0b00100, 0b00100, 0b00000]
}

export interface BadgeBitmap {
  /** What the badge shows — `9+` above the legible single-digit range. */
  text: string
  width: number
  height: number
  /** RGBA, row-major, width*height*4 bytes. */
  pixels: Buffer
}

/** Keep the visual label short; the overlay description retains the exact count. */
export function badgeOverlayText(unreadCount: number): string {
  const count = Math.floor(unreadCount)
  return count > 9 ? '9+' : String(count)
}

/** Zero clears the overlay; positive counts render a large red numeric circle. */
export function badgeOverlayBitmap(unreadCount: number): BadgeBitmap | null {
  if (!Number.isFinite(unreadCount) || unreadCount <= 0) return null
  const text = badgeOverlayText(unreadCount)
  const size = BADGE_OVERLAY_SIZE
  const pixels = Buffer.alloc(size * size * 4)
  const center = size / 2

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.hypot(x + 0.5 - center, y + 0.5 - center)
      const coverage = Math.max(0, Math.min(1, CIRCLE_RADIUS + 0.5 - distance))
      if (coverage === 0) continue
      paint(pixels, x, y, [BACKGROUND[0], BACKGROUND[1], BACKGROUND[2], Math.round(255 * coverage)])
    }
  }

  const scale = text.length === 1 ? SINGLE_GLYPH_SCALE : MULTI_GLYPH_SCALE
  const spacing = text.length === 1 ? 0 : MULTI_GLYPH_SPACING
  const textWidth = text.length * GLYPH_WIDTH * scale + (text.length - 1) * spacing
  const textHeight = GLYPH_HEIGHT * scale
  let penX = Math.round((size - textWidth) / 2)
  const penY = Math.round((size - textHeight) / 2)

  for (const character of text) {
    const glyph = GLYPHS[character]
    if (!glyph) continue
    for (let row = 0; row < GLYPH_HEIGHT; row++) {
      for (let column = 0; column < GLYPH_WIDTH; column++) {
        if (!((glyph[row] >> (GLYPH_WIDTH - 1 - column)) & 1)) continue
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            paint(pixels, penX + column * scale + dx, penY + row * scale + dy, FOREGROUND)
          }
        }
      }
    }
    penX += GLYPH_WIDTH * scale + spacing
  }

  return { text, width: size, height: size, pixels }
}

const pngCache = new Map<string, Buffer>()

/** Encode the badge as PNG to keep its red channel stable in Electron on Windows. */
export function badgeOverlayPng(unreadCount: number): Buffer | null {
  const bitmap = badgeOverlayBitmap(unreadCount)
  if (!bitmap) return null
  const cached = pngCache.get(bitmap.text)
  if (cached) return cached
  const png = encodeRgbaPng(bitmap.width, bitmap.height, bitmap.pixels)
  pngCache.set(bitmap.text, png)
  return png
}

function paint(pixels: Buffer, x: number, y: number, rgba: readonly [number, number, number, number]): void {
  const offset = (y * BADGE_OVERLAY_SIZE + x) * 4
  pixels[offset] = rgba[0]
  pixels[offset + 1] = rgba[1]
  pixels[offset + 2] = rgba[2]
  pixels[offset + 3] = rgba[3]
}

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})

function encodeRgbaPng(width: number, height: number, pixels: Buffer): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 6

  const stride = width * 4
  const scanlines = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) pixels.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride)

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, 'ascii')
  const chunk = Buffer.alloc(12 + data.length)
  chunk.writeUInt32BE(data.length, 0)
  typeBytes.copy(chunk, 4)
  data.copy(chunk, 8)
  chunk.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 8 + data.length)
  return chunk
}

function crc32(bytes: Buffer): number {
  let value = 0xffffffff
  for (const byte of bytes) value = CRC_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8)
  return (value ^ 0xffffffff) >>> 0
}
