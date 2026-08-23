export type MailSurface = 'native' | 'light'

const SIGNATURE = '.gmail_signature_prefix, .gmail_signature'
const QUOTED_MAIL = '.gmail_quote, blockquote[type="cite"]'
const CANVAS_CANDIDATE = 'style, [bgcolor], [background], [style]'
const CSS_COMMENT = /\/\*[\s\S]*?\*\//g
const IMPORTANT = /\s*!\s*important\s*$/i
const GENERATED_CANVAS =
  /\b(?:url|(?:repeating-)?(?:linear|radial|conic)-gradient|image-set|cross-fade|element|paint|var)\s*\(/i
const DARK_COLOR_SCHEME = /\(\s*prefers-color-scheme\s*:\s*dark\s*\)/i
const INTERACTION_PSEUDO = /:(?:hover|active|focus(?:-visible|-within)?|visited)\b/gi
const PSEUDO_ELEMENT = /::[a-z-]+(?:\([^)]*\))?|:(?:before|after|first-letter|first-line)\b/gi
const CONDITIONAL_RULE = new Set(['container', 'document', 'layer', 'scope', 'supports'])
const BACKGROUND_PROPERTIES = ['background', 'background-color', 'background-image'] as const

const backgroundProbe = document.createElement('span').style

function isNeutralCanvas(value: string): boolean {
  const normalized = value.toLowerCase().replace(/\s+/g, '')
  if (
    normalized === '' ||
    normalized === 'transparent' ||
    normalized === 'none' ||
    normalized === 'white' ||
    normalized === '#fff' ||
    normalized === '#ffffff' ||
    normalized === '#ffffffff' ||
    normalized === 'rgb(255,255,255)' ||
    normalized === 'rgba(255,255,255,1)' ||
    normalized === 'rgba(255,255,255,0)' ||
    normalized === 'rgba(0,0,0,0)'
  ) {
    return true
  }
  return /^rgba\([^)]*,0(?:\.0+)?\)$/.test(normalized) || /^rgb\([^)]*\/0(?:\.0+)?%?\)$/.test(normalized)
}

function splitCssDeclarations(style: string): string[] {
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

function styleDeclarations(style: string): { property: string; value: string; raw: string }[] {
  return splitCssDeclarations(style).flatMap((raw) => {
    const separator = raw.indexOf(':')
    if (separator <= 0) return []
    const property = raw
      .slice(0, separator)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s/g, '')
      .toLowerCase()
    return [{ property, value: raw.slice(separator + 1).trim(), raw: raw.trim() }]
  })
}

function backgroundCreatesCanvas(property: string, rawValue: string): boolean {
  const value = rawValue.replace(CSS_COMMENT, '').replace(IMPORTANT, '').trim()
  if (!value || isNeutralCanvas(value)) return false

  // Assign a complete declaration so the browser handles comments and every
  // valid spelling of `!important` before we inspect the parsed longhands.
  backgroundProbe.cssText = `${property}:${rawValue}`
  const image = backgroundProbe.backgroundImage
  if (image && image.toLowerCase() !== 'none') return true
  const color = backgroundProbe.backgroundColor
  if (color && !isNeutralCanvas(color)) return true

  // CSS variables and image functions may be unresolved in a detached probe,
  // but they still create a sender-owned canvas once the stylesheet is applied.
  return GENERATED_CANVAS.test(value)
}

function legacyBackgroundCreatesCanvas(value: string): boolean {
  const trimmed = value.trim()
  if (!trimmed) return false
  const cssColor = /^[\da-f]{3,8}$/i.test(trimmed) ? `#${trimmed}` : trimmed
  return backgroundCreatesCanvas('background-color', cssColor)
}

function matchingBlockEnd(css: string, open: number): number {
  let depth = 0
  let quote: string | null = null
  let escaped = false
  for (let index = open; index < css.length; index += 1) {
    const character = css[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return -1
}

function splitCssList(prelude: string): string[] {
  const queries: string[] = []
  let current = ''
  let parentheses = 0
  let brackets = 0
  let quote: string | null = null
  let escaped = false
  for (const character of prelude) {
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
    else if (character === '(') parentheses += 1
    else if (character === ')') parentheses = Math.max(0, parentheses - 1)
    else if (character === '[') brackets += 1
    else if (character === ']') brackets = Math.max(0, brackets - 1)
    else if (character === ',' && parentheses === 0 && brackets === 0) {
      queries.push(current)
      current = ''
      continue
    }
    current += character
  }
  queries.push(current)
  return queries.map((query) => query.trim()).filter(Boolean)
}

function darkSchemeOnly(prelude: string): boolean {
  const queries = splitCssList(prelude)
  return (
    queries.length > 0 && queries.every((query) => DARK_COLOR_SCHEME.test(query) && !/\bnot\b/i.test(query))
  )
}

interface CssBlock {
  open: number
  preludeStart: number
  prelude: string
}

function nextCssBlock(css: string, start: number): CssBlock | null {
  let preludeStart = start
  let parentheses = 0
  let brackets = 0
  let quote: string | null = null
  let escaped = false

  for (let index = start; index < css.length; index += 1) {
    const character = css[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") quote = character
    else if (character === '(') parentheses += 1
    else if (character === ')') parentheses = Math.max(0, parentheses - 1)
    else if (character === '[') brackets += 1
    else if (character === ']') brackets = Math.max(0, brackets - 1)
    else if (character === ';' && parentheses === 0 && brackets === 0) preludeStart = index + 1
    else if (character === '{' && parentheses === 0 && brackets === 0) {
      return { open: index, preludeStart, prelude: css.slice(preludeStart, index).trim() }
    }
  }
  return null
}

function directDeclarations(css: string): string {
  let result = ''
  let cursor = 0
  let block = nextCssBlock(css, cursor)
  while (block) {
    const close = matchingBlockEnd(css, block.open)
    if (close < 0) break
    result += css.slice(cursor, block.preludeStart)
    cursor = close + 1
    block = nextCssBlock(css, cursor)
  }
  return result + css.slice(cursor)
}

function declarationsCreateCanvas(css: string): boolean {
  backgroundProbe.cssText = css
  const backgrounds = BACKGROUND_PROPERTIES.map(
    (property) => [property, backgroundProbe.getPropertyValue(property)] as const
  )
  return backgrounds.some(([property, value]) => value && backgroundCreatesCanvas(property, value))
}

function selectorMatchesDocument(document: Document, selectorList: string): boolean {
  return splitCssList(selectorList).some((selector) => {
    const candidates = [selector, selector.replace(PSEUDO_ELEMENT, '').replace(INTERACTION_PSEUDO, '')]
    return candidates.some((candidate, index) => {
      if (index === 1 && candidate === selector) return false
      try {
        return Boolean(candidate.trim() && document.querySelector(candidate))
      } catch {
        return false
      }
    })
  })
}

function stylesheetCreatesCanvas(css: string, document: Document): boolean {
  const source = css.replace(CSS_COMMENT, '')
  let cursor = 0
  let block = nextCssBlock(source, cursor)
  while (block) {
    const close = matchingBlockEnd(source, block.open)
    if (close < 0) return false
    const content = source.slice(block.open + 1, close)
    const atRule = /^@([\w-]+)\b([\s\S]*)$/i.exec(block.prelude)
    if (atRule) {
      const name = atRule[1].toLowerCase()
      const condition = atRule[2].trim()
      if (name === 'media') {
        if (!darkSchemeOnly(condition) && stylesheetCreatesCanvas(content, document)) return true
      } else if (CONDITIONAL_RULE.has(name) && stylesheetCreatesCanvas(content, document)) {
        return true
      }
    } else if (
      selectorMatchesDocument(document, block.prelude) &&
      declarationsCreateCanvas(directDeclarations(content))
    ) {
      return true
    }
    cursor = close + 1
    block = nextCssBlock(source, cursor)
  }
  return false
}

function elementCreatesCanvas(element: Element): boolean {
  if (
    element instanceof HTMLStyleElement &&
    stylesheetCreatesCanvas(element.textContent ?? '', element.ownerDocument)
  ) {
    return true
  }
  const bgcolor = element.getAttribute('bgcolor')
  if (bgcolor !== null && legacyBackgroundCreatesCanvas(bgcolor)) return true
  if (element.getAttribute('background')?.trim()) return true
  const style = (element as HTMLElement).style
  if (!style) return false
  return BACKGROUND_PROPERTIES.some((property) => {
    const value = style.getPropertyValue(property)
    return Boolean(value && backgroundCreatesCanvas(property, value))
  })
}

function hasAuthoredCanvas(root: ParentNode): boolean {
  if (root instanceof Element && root.matches(CANVAS_CANDIDATE) && elementCreatesCanvas(root)) return true
  return [...root.querySelectorAll(CANVAS_CANDIDATE)].some(elementCreatesCanvas)
}

/** Remove sender canvases from content classified for Attn's native dark surface. */
export function normalizeNativeMailDocument(root: ParentNode): void {
  root.querySelectorAll('style').forEach((style) => {
    style.remove()
  })
  root.querySelectorAll<HTMLElement>('[bgcolor], [background], [style]').forEach((element) => {
    element.removeAttribute('bgcolor')
    element.removeAttribute('background')
    const style = styleDeclarations(element.getAttribute('style') ?? '')
      .filter(({ property }) => !property.startsWith('background'))
      .map(({ raw }) => raw)
      .join('; ')
    if (style) element.setAttribute('style', style)
    else element.removeAttribute('style')
  })
}

/**
 * Most HTML mail reads cleanly on Attn's native dark canvas once sender colours
 * and backgrounds are normalized. Typography, media, tables, dimensions, and
 * layout do not require a white document. Keep the light canvas only when the
 * sender authored a non-neutral background or background image whose removal
 * would change the meaning of the document.
 */
export function mailSurfaceForHtml(html: string | null): MailSurface {
  if (!html?.trim()) return 'native'
  const document = new DOMParser().parseFromString(html, 'text/html')
  document.querySelectorAll(SIGNATURE).forEach((element) => {
    element.remove()
  })

  // A forward carries the original document inside its quote. Preserve a real
  // authored canvas there, but do not let ordinary quoted formatting promote
  // every later reply in the thread to a white document.
  const quoted = [...document.querySelectorAll(QUOTED_MAIL)]
  if (quoted.some(hasAuthoredCanvas)) return 'light'
  for (const element of quoted) element.remove()
  return hasAuthoredCanvas(document) ? 'light' : 'native'
}
