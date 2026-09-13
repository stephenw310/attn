/**
 * One CSS tokenizer and one colour parser for every mail surface (review R8).
 * The sanitizer, the surface classifier, the composer's style allowlist and the
 * fidelity walk all read the same untrusted inline styles; when each kept its
 * own splitter they disagreed about where a declaration ends, and the loosest
 * one decided what shipped.
 */

/**
 * Split on top-level `;` only. A CSSOM parser cannot be used here: jsdom
 * silently parses zero declarations out of values it does not fully support
 * (`inset`, `url(data:...;base64,…)`), which would hand an attacker exactly the
 * payload the quote filter exists to remove.
 */
export function splitCssDeclarations(style: string): string[] {
  const declarations: string[] = []
  let current = ''
  let depth = 0
  let quote: string | null = null
  let escaped = false

  for (const character of style) {
    if (escaped) {
      current += character
      escaped = false
      continue
    }
    if (character === '\\') {
      current += character
      escaped = true
      continue
    }
    if (quote) {
      current += character
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '(') depth += 1
    else if (character === ')') depth = Math.max(0, depth - 1)
    else if (character === ';' && depth === 0) {
      declarations.push(current)
      current = ''
      continue
    }
    current += character
  }
  declarations.push(current)
  return declarations
}

export interface CssDeclaration {
  /** Lowercased, comment- and whitespace-free property name. */
  property: string
  /** The text after the first `:`, trimmed but otherwise untouched. */
  value: string
  /** The whole trimmed declaration, for callers that re-emit it verbatim. */
  raw: string
}

const CSS_COMMENT = /\/\*[\s\S]*?\*\//g

/** Tokenize an inline `style` attribute; malformed fragments are dropped. */
export function cssDeclarations(style: string): CssDeclaration[] {
  return splitCssDeclarations(style).flatMap((raw) => {
    const separator = raw.indexOf(':')
    if (separator <= 0) return []
    const name = raw.slice(0, separator).replace(CSS_COMMENT, '').replace(/\s/g, '')
    const property = name.startsWith('--') ? name : name.toLowerCase()
    if (!property) return []
    return [{ property, value: raw.slice(separator + 1).trim(), raw: raw.trim() }]
  })
}

export interface RgbColor {
  red: number
  green: number
  blue: number
  alpha: number
}

const RGB_FUNCTION =
  /^rgba?\(\s*([\d.]+)(%?)[,\s]+([\d.]+)(%?)[,\s]+([\d.]+)(%?)(?:\s*[,/]\s*([\d.]+)(%?))?\s*\)$/i

/** Parse a serialized `rgb()`/`rgba()` colour; anything else is `null`. */
export function parsedRgbColor(value: string): RgbColor | null {
  const match = value.trim().match(RGB_FUNCTION)
  if (!match) return null
  const channel = (part: string, percent: string): number => {
    const numeric = Number(part)
    return percent ? (numeric / 100) * 255 : numeric
  }
  return {
    red: channel(match[1], match[2]),
    green: channel(match[3], match[4]),
    blue: channel(match[5], match[6]),
    alpha: match[7] ? Number(match[7]) / (match[8] ? 100 : 1) : 1
  }
}

/** Whether a serialized colour is exactly this opaque channel triple. */
export function isRgbColor(value: string, red: number, green: number, blue: number): boolean {
  const parsed = parsedRgbColor(value)
  return (
    parsed !== null &&
    parsed.alpha === 1 &&
    parsed.red === red &&
    parsed.green === green &&
    parsed.blue === blue
  )
}
