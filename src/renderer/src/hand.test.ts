import { describe, expect, it } from 'vitest'
import { HAND_WIDTH, sealPath, seededRandom, tornRulePath, tornStripPath } from './hand'

function points(path: string): { x: number; y: number }[] {
  return [...path.matchAll(/[ML](-?[\d.]+) (-?[\d.]+)/g)].map((match) => ({
    x: Number(match[1]),
    y: Number(match[2])
  }))
}

describe('seededRandom', () => {
  it('repeats its sequence for one seed and diverges for another', () => {
    const first = Array.from({ length: 8 }, seededRandom(42))
    const again = Array.from({ length: 8 }, seededRandom(42))
    const other = Array.from({ length: 8 }, seededRandom(43))
    expect(first).toEqual(again)
    expect(first).not.toEqual(other)
    for (const value of first) expect(value).toBeGreaterThanOrEqual(0)
    for (const value of first) expect(value).toBeLessThan(1)
  })

  it('keeps drawing new values for as long as the paper asks for them', () => {
    // A float64 multiply loses the low bits of this generator's product, which
    // cycled after about 11,000 draws. One sheet of paper asks for more than
    // that, so the fibres landed twice on the same coordinates at double the
    // intended alpha. Eight draws cannot see it; 40,000 can.
    const random = seededRandom(0x5eed17)
    const drawn = Array.from({ length: 40_000 }, random)
    expect(new Set(drawn).size).toBeGreaterThan(39_000)

    // The same rounding also drove three quarters of the outputs to a zero low
    // byte. Spread across the 256 buckets says the low bits still carry noise.
    const buckets = new Set(drawn.map((value) => Math.round(value * 0x7fffffff) % 256))
    expect(buckets.size).toBeGreaterThan(200)
  })
})

describe('hand-drawn paths', () => {
  it('draws the same rule every time, so a rule does not crawl between renders', () => {
    expect(tornRulePath()).toBe(tornRulePath())
    expect(tornRulePath(1)).not.toBe(tornRulePath(2))
  })

  it('keeps the rule inside its nominal box', () => {
    const drawn = points(tornRulePath())
    expect(drawn.length).toBeGreaterThan(100)
    expect(tornRulePath().endsWith('Z')).toBe(true)
    for (const point of drawn) {
      expect(point.x).toBeGreaterThanOrEqual(0)
      expect(point.x).toBeLessThanOrEqual(HAND_WIDTH)
      expect(point.y).toBeGreaterThan(0)
      expect(point.y).toBeLessThan(3)
    }
  })

  it('tears the strip along both edges without either edge crossing the other', () => {
    const drawn = points(tornStripPath())
    const byColumn = new Map<number, number[]>()
    for (const point of drawn) {
      const column = byColumn.get(point.x) ?? []
      column.push(point.y)
      byColumn.set(point.x, column)
    }
    expect(byColumn.size).toBeGreaterThan(100)
    for (const column of byColumn.values()) {
      // Every sampled column carries one point above the middle and one below,
      // so neither torn edge ever crosses the other.
      expect(Math.min(...column)).toBeGreaterThan(0)
      expect(Math.min(...column)).toBeLessThan(50)
      expect(Math.max(...column)).toBeGreaterThan(50)
      expect(Math.max(...column)).toBeLessThan(100)
    }
    // A wave alone would repeat; a tear does not.
    const heights = drawn.filter((point) => point.y < 50).map((point) => point.y.toFixed(2))
    expect(new Set(heights).size).toBeGreaterThan(50)
  })

  it('bites the seal edge without leaving its 32 by 32 box', () => {
    const drawn = points(sealPath())
    expect(sealPath().endsWith('Z')).toBe(true)
    for (const point of drawn) {
      expect(Math.hypot(point.x - 16, point.y - 16)).toBeLessThan(16)
    }
    const radii = drawn.map((point) => Math.hypot(point.x - 16, point.y - 16))
    expect(Math.max(...radii) - Math.min(...radii)).toBeGreaterThan(0.5)
  })
})
