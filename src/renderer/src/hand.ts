/**
 * Hand-drawn ornament, as path data.
 *
 * Every rule, torn highlight and seal edge in the mail chrome is one of these
 * paths. They are generated from a fixed seed, so a rule keeps the same
 * wobble across renders, across rows, and across screenshots. Callers draw
 * them in a nominal coordinate space and stretch them with
 * `preserveAspectRatio="none"`: a torn edge survives horizontal scaling, and
 * that is what keeps the list free of one resize observer per row.
 */

/** The nominal width every horizontal ornament is generated at. */
export const HAND_WIDTH = 600

/**
 * Deterministic noise. The same seed always draws the same line.
 *
 * `Math.imul` rather than `*`: the multiplier needs 30 bits and the state 31,
 * so a float64 product loses its low bits to rounding. That version cycled
 * after about 11,000 draws and left three quarters of the outputs with a zero
 * low byte, which showed up as paper fibres painted twice over each other at
 * double the alpha the stylesheet asks for.
 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1103515245) + 12345) & 0x7fffffff
    return state / 0x7fffffff
  }
}

/**
 * A wobble along one axis: three sine waves at unrelated frequencies, which
 * reads as a hand rather than as a repeating pattern.
 */
function wobbler(random: () => number, amplitude: number): (position: number) => number {
  const waves = [
    { period: 3.1 + random() * 2.4, phase: random() * Math.PI * 2, weight: 0.34 },
    { period: 11.5 + random() * 9, phase: random() * Math.PI * 2, weight: 0.36 },
    { period: 47 + random() * 40, phase: random() * Math.PI * 2, weight: 0.3 }
  ]
  return (position) => {
    let offset = 0
    for (const wave of waves) offset += Math.sin(position / wave.period + wave.phase) * wave.weight
    return offset * amplitude
  }
}

function trace(
  width: number,
  step: number,
  top: (x: number) => number,
  bottom: (x: number) => number
): string {
  const parts: string[] = []
  for (let x = 0; x <= width; x += step)
    parts.push(`${parts.length === 0 ? 'M' : 'L'}${x} ${top(x).toFixed(2)}`)
  parts.push(`L${width} ${top(width).toFixed(2)}`)
  for (let x = width; x >= 0; x -= step) parts.push(`L${x} ${bottom(x).toFixed(2)}`)
  parts.push('Z')
  return parts.join(' ')
}

/**
 * A torn edge: the wobble of the tear, plus the fibre that comes away with it.
 * The jitter is what separates a tear from a wave, so it is sampled per point
 * rather than drawn from a wave of its own.
 */
function tornEdgeAt(
  random: () => number,
  wobble: (x: number) => number,
  spike: number,
  width: number,
  step: number
): (x: number) => number {
  const offsets: number[] = []
  for (let x = 0; x <= width + step; x += step) {
    offsets.push(
      wobble(x) + (random() < 0.22 ? (random() - 0.5) * spike * 2 : (random() - 0.5) * spike * 0.5)
    )
  }
  return (x) => offsets[Math.min(offsets.length - 1, Math.round(x / step))]
}

const ruleCache = new Map<number, string>()

/**
 * A ruled line, drawn by hand rather than set by a border. The path fills a
 * nominal box `HAND_WIDTH` wide and 3 tall, centered on its second pixel.
 */
export function tornRulePath(seed = 0x51190a3): string {
  const cached = ruleCache.get(seed)
  if (cached !== undefined) return cached
  const random = seededRandom(seed)
  const wobble = wobbler(random, 0.55)
  const path = trace(
    HAND_WIDTH,
    6,
    (x) => 1.1 + wobble(x),
    (x) => 2.2 + wobble(x)
  )
  ruleCache.set(seed, path)
  return path
}

const stripCache = new Map<number, string>()

/**
 * A torn strip of wash, the mark left when a reader tears a highlight out of a
 * page. The path fills a nominal box `HAND_WIDTH` wide and 100 tall, so a row
 * of any height can stretch it.
 */
export function tornStripPath(seed = 0x5eed17): string {
  const cached = stripCache.get(seed)
  if (cached !== undefined) return cached
  const random = seededRandom(seed)
  const step = 4
  const top = tornEdgeAt(random, wobbler(random, 2.4), 3.4, HAND_WIDTH, step)
  const bottom = tornEdgeAt(random, wobbler(random, 2.4), 3.4, HAND_WIDTH, step)
  const path = trace(
    HAND_WIDTH,
    step,
    (x) => 5 + top(x),
    (x) => 95 + bottom(x)
  )
  stripCache.set(seed, path)
  return path
}

/**
 * The bitten edge of a wax seal: a circle a stamp pressed unevenly. The path
 * is centered in a nominal 32 by 32 box.
 */
const sealCache = new Map<number, string>()

export function sealPath(seed = 0x5ea1): string {
  const cached = sealCache.get(seed)
  if (cached !== undefined) return cached
  const random = seededRandom(seed)
  const phases = [random(), random(), random(), random()].map((value) => value * Math.PI * 2)
  const radius = 14.2
  const steps = 96
  const parts: string[] = []
  for (let step = 0; step < steps; step++) {
    const angle = (step / steps) * Math.PI * 2
    const bite =
      Math.sin(angle * 3 + phases[0]) * 0.8 +
      Math.sin(angle * 7 + phases[1]) * 0.5 +
      Math.sin(angle * 13 + phases[2]) * 0.3 +
      (Math.sin(angle * 2 + phases[3]) > 0.93 ? -1.6 : 0)
    const distance = radius + bite
    const x = 16 + Math.cos(angle) * distance
    const y = 16 + Math.sin(angle) * distance
    parts.push(`${step === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`)
  }
  parts.push('Z')
  const path = parts.join(' ')
  sealCache.set(seed, path)
  return path
}

/**
 * The outline of a scrap of paper torn on all four edges. Unlike the rules and
 * the strip, this one is generated at its true pixel size rather than stretched
 * from a nominal box: a scrap is squarish, so scaling one axis would leave the
 * tear coarse along one edge and fine along the other.
 */
export function tornScrapPath(width: number, height: number, seed = 0x5c1a9): string {
  if (width <= 0 || height <= 0) return ''
  const random = seededRandom(seed)
  const step = 4
  const amplitude = 2.6
  const top = tornEdgeAt(random, wobbler(random, amplitude), 3.2, width, step)
  const bottom = tornEdgeAt(random, wobbler(random, amplitude), 3.2, width, step)
  const left = tornEdgeAt(random, wobbler(random, amplitude), 3.2, height, step)
  const right = tornEdgeAt(random, wobbler(random, amplitude), 3.2, height, step)
  const parts: string[] = []
  const at = (x: number, y: number): void => {
    parts.push(`${parts.length === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`)
  }
  for (let x = 0; x <= width; x += step) at(x, 4 + top(x))
  for (let y = 0; y <= height; y += step) at(width - 4 + right(y), y)
  for (let x = width; x >= 0; x -= step) at(x, height - 4 + bottom(x))
  for (let y = height; y >= 0; y -= step) at(4 + left(y), y)
  parts.push('Z')
  return parts.join(' ')
}
