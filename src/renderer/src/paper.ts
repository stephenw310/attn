import { seededRandom } from './hand'

/**
 * The sheet the mail chrome is written on.
 *
 * One seeded pass paints vellum: mottling where the skin was thick, laid
 * fibre, flecks, and the darker band the sidebar sits on, torn down its right
 * edge. Every color comes from the palette in `app.css`, so the painter has no
 * theme of its own and repaints when the theme changes.
 */

/** The frame the ornament counts were tuned against. */
const REFERENCE_AREA = 1180 * 760

/**
 * Ornament counts grow with the window, but only so far. On a 4K display the
 * uncapped figure is nine times the reference, and the sheet is repainted
 * whenever the sidebar opens or closes.
 */
const MAX_ORNAMENT_SCALE = 2

export interface PaperPalette {
  base: string
  band: string
  fibre: string
  lift: string
  fleck: string
  cloud: string
  cloudLit: string
  shadow: string
  fibreAlpha: number
  liftMix: number
  cloudAlpha: number
  cloudLitAlpha: number
  fleckAlpha: number
  vignette: number
}

function channels(styles: CSSStyleDeclaration, name: string): string {
  return styles.getPropertyValue(name).trim().split(/\s+/).join(',')
}

function amount(styles: CSSStyleDeclaration, name: string): number {
  const value = Number.parseFloat(styles.getPropertyValue(name))
  return Number.isFinite(value) ? value : 0
}

/** Read the active palette. Call this again whenever the theme changes. */
export function readPaperPalette(root: Element): PaperPalette {
  const styles = getComputedStyle(root)
  return {
    base: styles.getPropertyValue('--attn-ground').trim(),
    band: styles.getPropertyValue('--attn-band').trim(),
    fibre: channels(styles, '--attn-paper-fibre'),
    lift: channels(styles, '--attn-paper-lift'),
    fleck: channels(styles, '--attn-paper-fleck'),
    cloud: channels(styles, '--attn-paper-cloud'),
    cloudLit: channels(styles, '--attn-paper-cloud-lit'),
    shadow: channels(styles, '--attn-paper-shadow'),
    fibreAlpha: amount(styles, '--attn-paper-fibre-alpha'),
    liftMix: amount(styles, '--attn-paper-lift-mix'),
    cloudAlpha: amount(styles, '--attn-paper-cloud-alpha'),
    cloudLitAlpha: amount(styles, '--attn-paper-cloud-lit-alpha'),
    fleckAlpha: amount(styles, '--attn-paper-fleck-alpha'),
    vignette: amount(styles, '--attn-paper-vignette')
  }
}

function ink(rgb: string, alpha: number): string {
  return `rgba(${rgb},${alpha.toFixed(4)})`
}

/**
 * The torn right edge of the sidebar band, as a function of height. Five sine
 * waves plus two rare bites give a tear that never repeats down a window.
 */
function tornEdge(bandWidth: number, phases: readonly number[]): (y: number) => number {
  return (y) =>
    bandWidth +
    Math.sin(y / 53 + phases[0]) * 2.6 +
    Math.sin(y / 21.5 + phases[1]) * 1.7 +
    Math.sin(y / 8.3 + phases[2]) * 1 +
    Math.sin(y / 3.1 + phases[3]) * 0.6 +
    Math.sin(y / 1.7 + phases[4]) * 0.35 +
    (Math.sin(y / 97 + phases[5]) > 0.86 ? -3.6 : 0) +
    (Math.sin(y / 61 + phases[6]) > 0.93 ? 2.8 : 0)
}

/**
 * Paint one sheet. `bandWidth` is the width of the darker stock the sidebar
 * sits on; pass 0 while the sidebar is collapsed and the sheet runs edge to
 * edge.
 */
export function paintPaper(
  context: CanvasRenderingContext2D,
  palette: PaperPalette,
  width: number,
  height: number,
  bandWidth: number
): void {
  if (width <= 0 || height <= 0) return
  const random = seededRandom(0x5eed17)
  const scale = Math.min(MAX_ORNAMENT_SCALE, (width * height) / REFERENCE_AREA)
  const count = (reference: number): number => Math.max(1, Math.round(reference * scale))

  context.setTransform(1, 0, 0, 1, 0, 0)
  context.clearRect(0, 0, width, height)
  context.fillStyle = palette.base
  context.fillRect(0, 0, width, height)

  // Mottling: dark where the skin was thick, light where it was scraped thin.
  for (let cloud = 0; cloud < count(60); cloud++) {
    const x = random() * width
    const y = random() * height
    const radius = 60 + random() ** 1.5 * 300
    const dark = random() < 0.55
    const color = dark ? palette.cloud : palette.cloudLit
    const alpha = (dark ? palette.cloudAlpha : palette.cloudLitAlpha) * (0.4 + random() * 0.6)
    if (alpha <= 0) continue
    const gradient = context.createRadialGradient(x, y, 0, x, y, radius)
    gradient.addColorStop(0, ink(color, alpha))
    gradient.addColorStop(1, ink(color, 0))
    context.fillStyle = gradient
    context.fillRect(x - radius, y - radius, radius * 2, radius * 2)
  }

  if (palette.vignette > 0) {
    const gradient = context.createRadialGradient(
      width * 0.55,
      height * 0.45,
      height * 0.35,
      width * 0.55,
      height * 0.45,
      width * 0.78
    )
    gradient.addColorStop(0, ink(palette.cloud, 0))
    gradient.addColorStop(1, ink(palette.cloud, palette.vignette))
    context.fillStyle = gradient
    context.fillRect(0, 0, width, height)
  }

  if (bandWidth > 0) {
    const phases = Array.from({ length: 7 }, () => random() * Math.PI * 2)
    const edgeAt = tornEdge(bandWidth, phases)
    const seam = new Path2D()
    const band = new Path2D()
    band.moveTo(0, 0)
    for (let y = 0; y <= height; y++) {
      const x = edgeAt(y)
      if (y === 0) seam.moveTo(x, y)
      else seam.lineTo(x, y)
      band.lineTo(x - 4, y)
    }
    band.lineTo(0, height)
    band.closePath()
    // The band is a second sheet laid on the first, so it casts its thickness
    // to the right. Three widening strokes, clipped to the open side, cost a
    // few operations where a per-scanline pass costs one for every pixel row.
    context.save()
    const rightOfSeam = new Path2D(seam)
    rightOfSeam.lineTo(width, height)
    rightOfSeam.lineTo(width, 0)
    rightOfSeam.closePath()
    context.clip(rightOfSeam)
    for (const spread of [14, 8, 4]) {
      context.strokeStyle = ink(palette.shadow, 0.05)
      context.lineWidth = spread
      context.stroke(seam)
    }
    context.restore()
    context.fillStyle = palette.band
    context.fill(band)
    // The fringe of loose fibre along the tear.
    for (let strand = 0; strand < count(1700); strand++) {
      const y = random() * height
      const reach = random() ** 1.9 * 10
      const x = edgeAt(y) - 3
      context.strokeStyle = ink(
        random() < 0.5 ? palette.lift : palette.fibre,
        0.11 * (1 - reach / 10) * (0.3 + random())
      )
      context.lineWidth = random() < 0.8 ? 0.7 : 1.2
      context.beginPath()
      context.moveTo(x, y)
      context.lineTo(x + reach, y + (random() - 0.5) * 5)
      context.stroke()
    }
  }

  // Fibre, laid with the grain and gathered where the pulp lay thick.
  const grain = Array.from({ length: 4 }, () => random() * Math.PI * 2)
  const density = (x: number, y: number): number =>
    Math.max(
      0.04,
      Math.min(
        1,
        0.5 +
          0.26 * Math.sin(x / 190 + grain[0]) +
          0.2 * Math.sin(y / 150 + grain[1]) +
          0.16 * Math.sin((x + y) / 95 + grain[2]) +
          0.12 * Math.sin((x - y) / 61 + grain[3])
      )
    )
  for (let strand = 0; strand < count(2400); strand++) {
    const x = random() * width
    const y = random() * height
    if (random() > density(x, y)) continue
    const angle = (random() < 0.72 ? 0 : Math.PI / 2) + (random() - 0.5) * 0.85
    const length = 18 + random() ** 2.1 * 120
    context.strokeStyle = ink(
      random() < palette.liftMix ? palette.lift : palette.fibre,
      palette.fibreAlpha * (0.35 + random() * 0.9)
    )
    context.lineWidth = 0.55 + random() * 0.7
    context.beginPath()
    context.moveTo(x, y)
    context.quadraticCurveTo(
      x + Math.cos(angle) * length * 0.5 + (random() - 0.5) * 26,
      y + Math.sin(angle) * length * 0.5 + (random() - 0.5) * 26,
      x + Math.cos(angle) * length,
      y + Math.sin(angle) * length
    )
    context.stroke()
  }

  // Flecks in the skin.
  for (let fleck = 0; fleck < count(74); fleck++) {
    const x = random() * width
    const y = random() * height
    const angle = random() * Math.PI
    const length = 1.5 + random() * 6
    context.strokeStyle = ink(palette.fleck, palette.fleckAlpha * (0.35 + random() * 0.65))
    context.lineWidth = 0.8 + random() * 1.5
    context.beginPath()
    context.moveTo(x, y)
    context.quadraticCurveTo(
      x + Math.cos(angle) * length * 0.5 + (random() - 0.5) * 3,
      y + Math.sin(angle) * length * 0.5 + (random() - 0.5) * 3,
      x + Math.cos(angle) * length,
      y + Math.sin(angle) * length
    )
    context.stroke()
  }
}
