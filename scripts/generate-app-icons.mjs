#!/usr/bin/env node
/**
 * Regenerate palette app icons with only Node built-ins.
 *
 * The source alpha channel is retained exactly. The mark and tab are found
 * from the source pixels, while the old glossy ground is flattened to each
 * palette's ground color. Run with `node scripts/generate-app-icons.mjs`.
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

function connectedComponent(seedX, seedY, candidate, width, height) {
  const labels = Buffer.alloc(width * height)
  const seen = Buffer.alloc(width * height)
  const queue = [[seedX, seedY]]
  while (queue.length) {
    const [x, y] = queue.pop()
    if (x < 0 || x >= width || y < 0 || y >= height) continue
    const index = y * width + x
    if (seen[index]) continue
    seen[index] = 1
    if (!candidate[index]) continue
    labels[index] = 1
    queue.push([x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1])
  }
  return labels
}

function labelsFor(source) {
  const { width, height, pixels } = source
  const markCandidate = Buffer.alloc(width * height)
  const tabCandidate = Buffer.alloc(width * height)
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4
      const red = pixels[index]
      const green = pixels[index + 1]
      const blue = pixels[index + 2]
      const alpha = pixels[index + 3]
      if (!alpha) continue
      const high = Math.max(red, green, blue)
      const low = Math.min(red, green, blue)
      if (high > 80 && high - low < 42) markCandidate[y * width + x] = 1
      if (red > green + 12 && green > blue + 10) tabCandidate[y * width + x] = 1
    }
  }
  const mark = connectedComponent(400, 300, markCandidate, width, height)
  const tab = connectedComponent(800, 500, tabCandidate, width, height)
  const labels = Buffer.alloc(width * height)
  for (let index = 0; index < labels.length; index += 1) labels[index] = mark[index] || (tab[index] ? 2 : 0)
  for (let pass = 0; pass < 3; pass += 1) {
    const next = Buffer.from(labels)
    for (let y = 1; y < height - 1; y += 1) {
      for (let x = 1; x < width - 1; x += 1) {
        const index = y * width + x
        if (labels[index]) continue
        const pixel = index * 4
        const high = Math.max(pixels[pixel], pixels[pixel + 1], pixels[pixel + 2])
        const low = Math.min(pixels[pixel], pixels[pixel + 1], pixels[pixel + 2])
        if (!pixels[pixel + 3] || (high < 40 && high - low < 25)) continue
        const counts = [0, 0, 0]
        for (let dy = -1; dy <= 1; dy += 1)
          for (let dx = -1; dx <= 1; dx += 1) counts[labels[(y + dy) * width + x + dx]] += 1
        next[index] = counts[2] > counts[1] && counts[2] > counts[0] ? 2 : counts[1] > counts[0] ? 1 : 0
      }
    }
    next.copy(labels)
  }
  return labels
}

function recolor(source, labels, colors) {
  const targets = colors.map(hexColor)
  const pixels = Buffer.alloc(source.pixels.length)
  for (let index = 0; index < labels.length; index += 1) {
    const sourceIndex = index * 4
    const color = targets[labels[index]]
    pixels[sourceIndex] = color[0]
    pixels[sourceIndex + 1] = color[1]
    pixels[sourceIndex + 2] = color[2]
    pixels[sourceIndex + 3] = source.pixels[sourceIndex + 3]
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
const labels = labelsFor(source)
for (const [name, colors] of Object.entries(palettes)) {
  const icon = recolor(source, labels, colors)
  writeFileSync(join(root, 'resources', `icon-${name}.png`), encodePng(icon))
  if (name === 'matcha') writeFileSync(join(root, 'resources', 'icon.png'), encodePng(icon))
}
writeIco(recolor(source, labels, palettes.matcha))
writeIcns(recolor(source, labels, palettes.matcha))
