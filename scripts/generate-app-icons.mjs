#!/usr/bin/env node
/**
 * Regenerate palette app icons with only Node built-ins.
 *
 * The source alpha, texture, shading, and reflective rim are retained.
 * Neutral tones are regraded into each palette; the orange tab becomes its
 * pale accent. Run with `node scripts/generate-app-icons.mjs`.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'

const root = join(import.meta.dirname, '..')
const sourcePath = join(root, 'resources', 'icon-source.png')
const palettes = {
  matcha: ['#2D3B34', '#F4F7F3', '#BED1BD'],
  mist: ['#2C3A44', '#F3F6F8', '#B8D0DF'],
  linen: ['#403A30', '#F8F6F1', '#D7C7AB'],
  dusk: ['#403543', '#F7F4F7', '#D5BFD6']
}

function u32(bytes, offset) {
  return bytes.readUInt32BE(offset)
}

function chunk(type, data) {
  const header = Buffer.alloc(8)
  header.writeUInt32BE(data.length, 0)
  header.write(type, 4, 4, 'ascii')
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([header.subarray(4), data])), 0)
  return Buffer.concat([header, data, checksum])
}

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1))
  }
  return (crc ^ 0xffffffff) >>> 0
}

function decodePng(buffer) {
  if (buffer.toString('ascii', 1, 4) !== 'PNG') throw new Error('expected PNG')
  let offset = 8
  let width = 0
  let height = 0
  const idat = []
  while (offset < buffer.length) {
    const length = u32(buffer, offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const data = buffer.subarray(offset + 8, offset + 8 + length)
    if (type === 'IHDR') {
      width = u32(data, 0)
      height = u32(data, 4)
      if (data[8] !== 8 || data[9] !== 6) throw new Error('source must be 8-bit RGBA PNG')
    } else if (type === 'IDAT') idat.push(data)
    offset += length + 12
  }
  const packed = inflateSync(Buffer.concat(idat))
  const pixels = Buffer.alloc(width * height * 4)
  const stride = width * 4
  let sourceOffset = 0
  for (let y = 0; y < height; y += 1) {
    const filter = packed[sourceOffset++]
    const row = pixels.subarray(y * stride, (y + 1) * stride)
    const previous = y === 0 ? null : pixels.subarray((y - 1) * stride, y * stride)
    for (let x = 0; x < stride; x += 1) {
      const left = x >= 4 ? row[x - 4] : 0
      const above = previous?.[x] ?? 0
      const aboveLeft = previous?.[x - 4] ?? 0
      const value = packed[sourceOffset++]
      if (filter === 0) row[x] = value
      else if (filter === 1) row[x] = (value + left) & 0xff
      else if (filter === 2) row[x] = (value + above) & 0xff
      else if (filter === 3) row[x] = (value + Math.floor((left + above) / 2)) & 0xff
      else if (filter === 4) {
        const p = left + above - aboveLeft
        const pa = Math.abs(p - left)
        const pb = Math.abs(p - above)
        const pc = Math.abs(p - aboveLeft)
        row[x] = (value + (pa <= pb && pa <= pc ? left : pb <= pc ? above : aboveLeft)) & 0xff
      } else throw new Error(`unsupported PNG filter ${filter}`)
    }
  }
  return { width, height, pixels }
}

function encodePng({ width, height, pixels }) {
  const stride = width * 4
  const packed = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y += 1) {
    packed[y * (stride + 1)] = 0
    pixels.copy(packed, y * (stride + 1) + 1, y * stride, (y + 1) * stride)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  return Buffer.concat([
    Buffer.from('\x89PNG\r\n\x1a\n', 'binary'),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(packed)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function hexColor(value) {
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16)
  ]
}

/** Regrade the source lighting without thresholding the mark or its antialiasing. */
function recolor(source, colors) {
  const [ground, mark, tab] = colors.map(hexColor)
  const pixels = Buffer.alloc(source.pixels.length)
  const neutral = (value, channel) => {
    // The original dark material sits near 20/255. Retain its shadows below
    // that point and the full highlight range, including the pearl mark's texture.
    if (value <= 20) return ground[channel] * (0.6 + (0.4 * value) / 20)
    const light = (value - 20) / 235
    return ground[channel] + (mark[channel] - ground[channel]) * light
  }
  for (let index = 0; index < source.pixels.length; index += 4) {
    const [red, green, blue, alpha] = source.pixels.subarray(index, index + 4)
    if (alpha === 0) continue
    // Orange is the source tab. Its chroma supplies a continuous coverage
    // mask, preserving the fold, texture, and blended boundary pixels.
    const tabCoverage = red > green && green > blue ? (red - blue) / 255 : 0
    const shade = tabCoverage > 0 ? blue : (red + green + blue) / 3
    for (let channel = 0; channel < 3; channel += 1) {
      pixels[index + channel] = Math.round(
        neutral(shade, channel) * (1 - tabCoverage) + tab[channel] * tabCoverage
      )
    }
    pixels[index + 3] = alpha
  }
  return { width: source.width, height: source.height, pixels }
}

function resize(source, size) {
  const pixels = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const startX = Math.floor((x * source.width) / size)
      const endX = Math.max(startX + 1, Math.ceil(((x + 1) * source.width) / size))
      const startY = Math.floor((y * source.height) / size)
      const endY = Math.max(startY + 1, Math.ceil(((y + 1) * source.height) / size))
      let alpha = 0
      let red = 0
      let green = 0
      let blue = 0
      for (let sourceY = startY; sourceY < endY; sourceY += 1) {
        for (let sourceX = startX; sourceX < endX; sourceX += 1) {
          const sourceIndex = (sourceY * source.width + sourceX) * 4
          const sourceAlpha = source.pixels[sourceIndex + 3]
          alpha += sourceAlpha
          red += source.pixels[sourceIndex] * sourceAlpha
          green += source.pixels[sourceIndex + 1] * sourceAlpha
          blue += source.pixels[sourceIndex + 2] * sourceAlpha
        }
      }
      const count = (endX - startX) * (endY - startY)
      const outputIndex = (y * size + x) * 4
      const outputAlpha = Math.round(alpha / count)
      pixels[outputIndex + 3] = outputAlpha
      if (alpha > 0) {
        pixels[outputIndex] = Math.round(red / alpha)
        pixels[outputIndex + 1] = Math.round(green / alpha)
        pixels[outputIndex + 2] = Math.round(blue / alpha)
      }
    }
  }
  return { width: size, height: size, pixels }
}

function writeIco(icon) {
  const sizes = [16, 32, 48, 64, 128, 256]
  const pngs = sizes.map((size) => encodePng(resize(icon, size)))
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  const entries = Buffer.alloc(sizes.length * 16)
  let offset = 6 + entries.length
  for (let index = 0; index < sizes.length; index += 1) {
    const size = sizes[index]
    entries[index * 16] = size === 256 ? 0 : size
    entries[index * 16 + 1] = size === 256 ? 0 : size
    entries.writeUInt16LE(1, index * 16 + 4)
    entries.writeUInt16LE(32, index * 16 + 6)
    entries.writeUInt32LE(pngs[index].length, index * 16 + 8)
    entries.writeUInt32LE(offset, index * 16 + 12)
    offset += pngs[index].length
  }
  writeFileSync(join(root, 'resources', 'icon.ico'), Buffer.concat([header, entries, ...pngs]))
}

function writeIcns(icon) {
  const entries = [
    ['ic11', 32],
    ['ic12', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic13', 256],
    ['ic09', 512],
    ['ic14', 512],
    ['ic10', 1024]
  ].map(([type, size]) => {
    const data = encodePng(resize(icon, size))
    const header = Buffer.alloc(8)
    header.write(type, 0, 4, 'ascii')
    header.writeUInt32BE(data.length + 8, 4)
    return Buffer.concat([header, data])
  })
  const output = Buffer.concat(entries)
  const header = Buffer.alloc(8)
  header.write('icns', 0, 4, 'ascii')
  header.writeUInt32BE(output.length + 8, 4)
  writeFileSync(join(root, 'resources', 'icon.icns'), Buffer.concat([header, output]))
}

const source = decodePng(readFileSync(sourcePath))
for (const [name, colors] of Object.entries(palettes)) {
  const icon = recolor(source, colors)
  writeFileSync(join(root, 'resources', `icon-${name}.png`), encodePng(icon))
  if (name === 'matcha') writeFileSync(join(root, 'resources', 'icon.png'), encodePng(icon))
}
writeIco(recolor(source, palettes.matcha))
writeIcns(recolor(source, palettes.matcha))
