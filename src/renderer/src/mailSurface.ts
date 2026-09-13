import { cssDeclarations, parsedRgbColor, type RgbColor } from '../../shared/css'
import { normalizeAppleMailLineBackgrounds } from './mailAppleBackgrounds'

export type MailSurface = 'native' | 'light'
export type MailLayout = 'padded' | 'centered' | 'full-bleed'

export interface MailPresentation {
  surface: MailSurface
  layout: MailLayout
}

const SIGNATURE = '.gmail_signature_prefix, .gmail_signature'
const CSS_COMMENT = /\/\*[\s\S]*?\*\//g
const IMPORTANT = /\s*!\s*important\s*$/i
const GENERATED_CANVAS =
  /\b(?:url|(?:repeating-)?(?:linear|radial|conic)-gradient|image-set|cross-fade|element|paint|var)\s*\(/i
const DARK_COLOR_SCHEME_SOURCE = String.raw`\(\s*prefers-color-scheme\s*:\s*dark\s*\)`
const DARK_COLOR_SCHEME = new RegExp(DARK_COLOR_SCHEME_SOURCE, 'i')
const EVERY_DARK_COLOR_SCHEME = new RegExp(DARK_COLOR_SCHEME_SOURCE, 'gi')
const ALWAYS_FALSE_LIGHT_MEDIA_FEATURE = '(width < 0px)'
const INTERACTION_PSEUDO = /:(?:hover|active|focus(?:-visible|-within)?|visited)\b/gi
const PSEUDO_ELEMENT = /::[a-z-]+(?:\([^)]*\))?|:(?:before|after|first-letter|first-line)\b/gi
const CONDITIONAL_RULE = new Set(['container', 'document', 'layer', 'scope', 'supports'])
const BACKGROUND_PROPERTIES = ['background', 'background-color', 'background-image'] as const
const BACKGROUND_LONGHANDS = ['background-color', 'background-image'] as const
const FRAME_BORDER_MIN_PX = 8
const BORDER_SIDES = ['top', 'right', 'bottom', 'left'] as const
const NATIVE_BACKGROUND = { red: 16, green: 17, blue: 20 }
const MIN_NATIVE_TEXT_CONTRAST = 4.5
const NEUTRAL_TEXT_CHROMA = 24

const backgroundProbe = document.createElement('span').style
const textColorProbe = document.createElement('span').style

/**
 * Resolving a named colour needs a live element: `getComputedStyle` on a probe
 * attached to the document forces layout, and `normalizeNativeMailDocument`
 * asks per declaration. A newsletter repeats a handful of colours across
 * hundreds of elements, so the answer is cached by the declaration text it was
 * derived from (review P7).
 */
const resolvedTextColors = new Map<string, RgbColor | null>()

function resolveTextColor(raw: string): RgbColor | null {
  textColorProbe.cssText = ''
  textColorProbe.color = raw
  if (!textColorProbe.color) return null

  let serialized = textColorProbe.color
  if (!/^rgba?\(/i.test(serialized)) {
    const probe = document.createElement('span')
    probe.style.color = serialized
    document.documentElement.append(probe)
    serialized = window.getComputedStyle(probe).color
    probe.remove()
  }
  return parsedRgbColor(serialized)
}

function resolvedTextColor(value: string): RgbColor | null {
  const raw = value.replace(CSS_COMMENT, '').replace(IMPORTANT, '').trim()
  if (!raw || /^(?:currentcolor|transparent)$/i.test(raw) || /var\s*\(/i.test(raw)) return null
  const cached = resolvedTextColors.get(raw)
  if (cached !== undefined) return cached
  const resolved = resolveTextColor(raw)
  resolvedTextColors.set(raw, resolved)
  return resolved
}

function linearChannel(channel: number): number {
  const normalized = channel / 255
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4
}

function relativeLuminance(color: Pick<RgbColor, 'red' | 'green' | 'blue'>): number {
  return (
    0.2126 * linearChannel(color.red) +
    0.7152 * linearChannel(color.green) +
    0.0722 * linearChannel(color.blue)
  )
}

function contrastRatio(
  foreground: Pick<RgbColor, 'red' | 'green' | 'blue'>,
  background: Pick<RgbColor, 'red' | 'green' | 'blue'>
): number {
  const lighter = Math.max(relativeLuminance(foreground), relativeLuminance(background))
  const darker = Math.min(relativeLuminance(foreground), relativeLuminance(background))
  return (lighter + 0.05) / (darker + 0.05)
}

function serializedRgb(color: Pick<RgbColor, 'red' | 'green' | 'blue'>): string {
  return `rgb(${Math.round(color.red)}, ${Math.round(color.green)}, ${Math.round(color.blue)})`
}

function nativeTextColor(value: string): string | null {
  const parsed = resolvedTextColor(value)
  if (!parsed || parsed.alpha === 0) return null
  const color = {
    red: parsed.red * parsed.alpha + NATIVE_BACKGROUND.red * (1 - parsed.alpha),
    green: parsed.green * parsed.alpha + NATIVE_BACKGROUND.green * (1 - parsed.alpha),
    blue: parsed.blue * parsed.alpha + NATIVE_BACKGROUND.blue * (1 - parsed.alpha)
  }
  if (contrastRatio(color, NATIVE_BACKGROUND) >= MIN_NATIVE_TEXT_CONTRAST) {
    return serializedRgb(color)
  }

  const chroma = Math.max(color.red, color.green, color.blue) - Math.min(color.red, color.green, color.blue)
  if (chroma < NEUTRAL_TEXT_CHROMA) return null

  for (let white = 0.01; white <= 1; white += 0.01) {
    const adjusted = {
      red: color.red + (255 - color.red) * white,
      green: color.green + (255 - color.green) * white,
      blue: color.blue + (255 - color.blue) * white
    }
    if (contrastRatio(adjusted, NATIVE_BACKGROUND) >= MIN_NATIVE_TEXT_CONTRAST) {
      return serializedRgb(adjusted)
    }
  }
  return null
}

function isNeutralCanvas(value: string): boolean {
  const parsed = parsedRgbColor(value.replace(CSS_COMMENT, '').replace(IMPORTANT, '').trim())
  if (
    parsed &&
    (parsed.alpha === 0 ||
      (parsed.alpha === 1 && parsed.red === 255 && parsed.green === 255 && parsed.blue === 255))
  ) {
    return true
  }
  const normalized = value.toLowerCase().replace(/\s+/g, '')
  if (
    normalized === '' ||
    normalized === 'initial' ||
    normalized === 'unset' ||
    normalized === 'revert' ||
    normalized === 'revert-layer' ||
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

function legacyBackgroundValue(value: string): string {
  const trimmed = value.trim()
  return /^[\da-f]{3,8}$/i.test(trimmed) ? `#${trimmed}` : trimmed
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

function mediaQueryCanApplyOnLightScreen(query: string): boolean {
  let condition = query.trim()
  if (!condition) return false

  const qualifierMatch = /^(not|only)\b/i.exec(condition)
  const qualifier = qualifierMatch?.[1].toLowerCase() ?? ''
  if (qualifierMatch) condition = condition.slice(qualifierMatch[0].length).trim()

  const typeMatch = condition.startsWith('(') ? null : /^([a-z][\w-]*)\b/i.exec(condition)
  const mediaType = typeMatch?.[1].toLowerCase() ?? 'all'
  const typeMatchesScreen = typeMatch === null || mediaType === 'screen' || mediaType === 'all'

  // `not` negates the complete query. On a light screen, either a non-screen
  // media type or a required dark color scheme makes the inner query false.
  if (qualifier === 'not') return !typeMatchesScreen || DARK_COLOR_SCHEME.test(condition)
  if (!typeMatchesScreen) return false

  return !DARK_COLOR_SCHEME.test(condition)
}

function lightScreenMediaCanApply(prelude: string): boolean {
  return splitCssList(prelude).some(mediaQueryCanApplyOnLightScreen)
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

type BackgroundLonghand = (typeof BACKGROUND_LONGHANDS)[number]
type Specificity = readonly [ids: number, classes: number, types: number]

interface BackgroundDeclaration {
  longhand: BackgroundLonghand
  sourceProperty: (typeof BACKGROUND_PROPERTIES)[number]
  value: string
  important: boolean
}

interface CascadedBackground extends BackgroundDeclaration {
  inline: boolean
  specificity: Specificity
  order: number
}

type BackgroundWinners = Partial<Record<BackgroundLonghand, CascadedBackground>>

function backgroundDeclarations(css: string): BackgroundDeclaration[] {
  backgroundProbe.cssText = css
  const parsed = BACKGROUND_LONGHANDS.flatMap((longhand) => {
    const value = backgroundProbe.getPropertyValue(longhand)
    return value
      ? [
          {
            longhand,
            sourceProperty: longhand,
            value,
            important: backgroundProbe.getPropertyPriority(longhand) === 'important'
          } satisfies BackgroundDeclaration
        ]
      : []
  })
  if (parsed.length > 0) return parsed

  // A shorthand containing a custom property stays unresolved in a detached
  // declaration block. Keep treating it as sender-owned, while still giving a
  // later shorthand the chance to replace both longhands through the cascade.
  const shorthand = backgroundProbe.getPropertyValue('background')
  if (!shorthand || !GENERATED_CANVAS.test(shorthand)) return []
  const important = backgroundProbe.getPropertyPriority('background') === 'important'
  return BACKGROUND_LONGHANDS.map((longhand) => ({
    longhand,
    sourceProperty: 'background',
    value: shorthand,
    important
  }))
}

function addSpecificity(left: Specificity, right: Specificity): Specificity {
  return [left[0] + right[0], left[1] + right[1], left[2] + right[2]]
}

function compareSpecificity(left: Specificity, right: Specificity): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return left[index] - right[index]
  }
  return 0
}

function matchingDelimiterEnd(source: string, open: number, opening: string, closing: string): number {
  let depth = 0
  let quote: string | null = null
  let escaped = false
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]
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
    else if (character === opening) depth += 1
    else if (character === closing) {
      depth -= 1
      if (depth === 0) return index
    }
  }
  return source.length - 1
}

function identifierEnd(source: string, start: number): number {
  let index = start
  while (index < source.length) {
    const character = source[index]
    if (character === '\\') index += Math.min(2, source.length - index)
    else if (/[\w-]/.test(character) || character.charCodeAt(0) >= 0x80) index += 1
    else break
  }
  return index
}

function maxSpecificity(selectorList: string): Specificity {
  return splitCssList(selectorList)
    .map(selectorSpecificity)
    .reduce<Specificity>(
      (best, specificity) => (compareSpecificity(specificity, best) > 0 ? specificity : best),
      [0, 0, 0]
    )
}

function selectorSpecificity(selector: string): Specificity {
  let specificity: Specificity = [0, 0, 0]
  let index = 0
  let typeAllowed = true
  while (index < selector.length) {
    const character = selector[index]
    if (/\s/.test(character) || character === '>' || character === '+' || character === '~') {
      typeAllowed = true
      index += 1
      continue
    }
    if (character === '#') {
      specificity = addSpecificity(specificity, [1, 0, 0])
      index = identifierEnd(selector, index + 1)
      typeAllowed = false
      continue
    }
    if (character === '.') {
      specificity = addSpecificity(specificity, [0, 1, 0])
      index = identifierEnd(selector, index + 1)
      typeAllowed = false
      continue
    }
    if (character === '[') {
      specificity = addSpecificity(specificity, [0, 1, 0])
      index = matchingDelimiterEnd(selector, index, '[', ']') + 1
      typeAllowed = false
      continue
    }
    if (character === ':') {
      const pseudoElement = selector[index + 1] === ':'
      const nameStart = index + (pseudoElement ? 2 : 1)
      const nameEnd = identifierEnd(selector, nameStart)
      const name = selector.slice(nameStart, nameEnd).toLowerCase()
      const legacyPseudoElement =
        !pseudoElement && ['after', 'before', 'first-letter', 'first-line'].includes(name)
      const open = selector[nameEnd] === '(' ? nameEnd : -1
      const close = open >= 0 ? matchingDelimiterEnd(selector, open, '(', ')') : nameEnd - 1
      if (pseudoElement || legacyPseudoElement) {
        specificity = addSpecificity(specificity, [0, 0, 1])
      } else if (name === 'is' || name === 'not' || name === 'has') {
        specificity = addSpecificity(specificity, maxSpecificity(selector.slice(open + 1, close)))
      } else if (name !== 'where') {
        specificity = addSpecificity(specificity, [0, 1, 0])
        if ((name === 'nth-child' || name === 'nth-last-child') && open >= 0) {
          const argument = selector.slice(open + 1, close)
          const of = /\bof\b([\s\S]*)$/i.exec(argument)
          if (of) specificity = addSpecificity(specificity, maxSpecificity(of[1]))
        }
      }
      index = open >= 0 ? close + 1 : nameEnd
      typeAllowed = false
      continue
    }
    if (character === '*') {
      index += 1
      typeAllowed = false
      continue
    }
    if (
      typeAllowed &&
      (/[a-z_-]/i.test(character) || character === '\\' || character.charCodeAt(0) >= 0x80)
    ) {
      specificity = addSpecificity(specificity, [0, 0, 1])
      index = identifierEnd(selector, index)
      if (selector[index] === '|') {
        index += 1
        index = selector[index] === '*' ? index + 1 : identifierEnd(selector, index)
      }
      typeAllowed = false
      continue
    }
    index += 1
  }
  return specificity
}

function matchingElements(document: Document, selector: string): Element[] {
  const normalized = selector.replace(PSEUDO_ELEMENT, '').replace(INTERACTION_PSEUDO, '')
  const candidates = normalized === selector ? [selector] : [selector, normalized]
  for (const candidate of candidates) {
    try {
      if (!candidate.trim()) continue
      const matches = [...document.querySelectorAll(candidate)]
      if (matches.length > 0) return matches
    } catch {
      // Try the normalized selector after browser-state pseudo-classes.
    }
  }
  return []
}

function winsCascade(candidate: CascadedBackground, current: CascadedBackground | undefined): boolean {
  if (!current) return true
  if (candidate.important !== current.important) return candidate.important
  if (candidate.inline !== current.inline) return candidate.inline
  const specificity = compareSpecificity(candidate.specificity, current.specificity)
  if (specificity !== 0) return specificity > 0
  return candidate.order >= current.order
}

function applyBackgroundDeclarations(
  winners: Map<Element, BackgroundWinners>,
  elements: Iterable<Element>,
  declarations: readonly BackgroundDeclaration[],
  cascade: Pick<CascadedBackground, 'inline' | 'specificity' | 'order'>
): void {
  for (const element of elements) {
    const elementWinners = winners.get(element) ?? {}
    for (const declaration of declarations) {
      const candidate = { ...declaration, ...cascade }
      if (winsCascade(candidate, elementWinners[declaration.longhand])) {
        elementWinners[declaration.longhand] = candidate
      }
    }
    winners.set(element, elementWinners)
  }
}

function applyStylesheetBackgrounds(
  css: string,
  document: Document,
  winners: Map<Element, BackgroundWinners>,
  sourceOrder: { value: number }
): void {
  const source = css.replace(CSS_COMMENT, '')
  let cursor = 0
  let block = nextCssBlock(source, cursor)
  while (block) {
    const close = matchingBlockEnd(source, block.open)
    if (close < 0) return
    const content = source.slice(block.open + 1, close)
    const atRule = /^@([\w-]+)\b([\s\S]*)$/i.exec(block.prelude)
    if (atRule) {
      const name = atRule[1].toLowerCase()
      const condition = atRule[2].trim()
      if (name === 'media') {
        if (lightScreenMediaCanApply(condition)) {
          applyStylesheetBackgrounds(content, document, winners, sourceOrder)
        }
      } else if (CONDITIONAL_RULE.has(name)) {
        applyStylesheetBackgrounds(content, document, winners, sourceOrder)
      }
    } else {
      const declarations = backgroundDeclarations(directDeclarations(content))
      const order = sourceOrder.value
      sourceOrder.value += 1
      if (declarations.length > 0) {
        for (const selector of splitCssList(block.prelude)) {
          applyBackgroundDeclarations(winners, matchingElements(document, selector), declarations, {
            inline: false,
            specificity: selectorSpecificity(selector),
            order
          })
        }
      }
    }
    cursor = close + 1
    block = nextCssBlock(source, cursor)
  }
}

function authoredBackgrounds(document: Document): Map<Element, BackgroundWinners> {
  const winners = new Map<Element, BackgroundWinners>()
  document.querySelectorAll('[bgcolor]').forEach((element) => {
    const value = legacyBackgroundValue(element.getAttribute('bgcolor') ?? '')
    if (!value) return
    applyBackgroundDeclarations(
      winners,
      [element],
      [{ longhand: 'background-color', sourceProperty: 'background-color', value, important: false }],
      { inline: false, specificity: [0, 0, 0], order: -1 }
    )
  })
  document.querySelectorAll('[background]').forEach((element) => {
    const value = element.getAttribute('background')?.trim()
    if (!value) return
    applyBackgroundDeclarations(
      winners,
      [element],
      [
        {
          longhand: 'background-image',
          sourceProperty: 'background-image',
          value: `url(${JSON.stringify(value)})`,
          important: false
        }
      ],
      { inline: false, specificity: [0, 0, 0], order: -1 }
    )
  })

  const sourceOrder = { value: 0 }
  document.querySelectorAll('style').forEach((style) => {
    applyStylesheetBackgrounds(style.textContent ?? '', document, winners, sourceOrder)
  })
  document.querySelectorAll('[style]').forEach((element) => {
    applyBackgroundDeclarations(
      winners,
      [element],
      backgroundDeclarations(element.getAttribute('style') ?? ''),
      { inline: true, specificity: [0, 0, 0], order: sourceOrder.value }
    )
  })

  return winners
}

function winnersCreateCanvas(elementWinners: BackgroundWinners | undefined): boolean {
  return Boolean(
    elementWinners &&
      BACKGROUND_LONGHANDS.some((longhand) => {
        const winner = elementWinners[longhand]
        return Boolean(winner && backgroundCreatesCanvas(winner.sourceProperty, winner.value))
      })
  )
}

function hasAuthoredCanvas(winners: Map<Element, BackgroundWinners>): boolean {
  return [...winners.values()].some(winnersCreateCanvas)
}

function visibleThickBorder(style: CSSStyleDeclaration, side: (typeof BORDER_SIDES)[number]): boolean {
  const width = style.getPropertyValue(`border-${side}-width`).trim()
  const match = /^(\d+(?:\.\d+)?)px$/i.exec(width)
  if (!match || Number(match[1]) < FRAME_BORDER_MIN_PX) return false

  const borderStyle = style.getPropertyValue(`border-${side}-style`).trim().toLowerCase()
  if (!borderStyle || borderStyle === 'none' || borderStyle === 'hidden') return false

  const color = style.getPropertyValue(`border-${side}-color`).trim()
  if (!color) return true
  if (/^transparent$/i.test(color)) return false
  return resolvedTextColor(color)?.alpha !== 0
}

/** A thick frame around both axes is a sender-owned canvas even when its fill is pure white. */
function hasAuthoredFrame(document: Document): boolean {
  return [...document.querySelectorAll<HTMLElement>('[style]')].some((element) => {
    const sides = new Set(BORDER_SIDES.filter((side) => visibleThickBorder(element.style, side)))
    return BORDER_SIDES.every((side) => sides.has(side))
  })
}

function applyMatchingStyleDeclarations(
  css: string,
  document: Document,
  element: Element,
  declarations: CSSStyleDeclaration[]
): void {
  const source = css.replace(CSS_COMMENT, '')
  let cursor = 0
  let block = nextCssBlock(source, cursor)
  while (block) {
    const close = matchingBlockEnd(source, block.open)
    if (close < 0) return
    const content = source.slice(block.open + 1, close)
    const atRule = /^@([\w-]+)\b([\s\S]*)$/i.exec(block.prelude)
    if (atRule) {
      const name = atRule[1].toLowerCase()
      const condition = atRule[2].trim()
      if (name === 'media') {
        if (lightScreenMediaCanApply(condition)) {
          applyMatchingStyleDeclarations(content, document, element, declarations)
        }
      } else if (CONDITIONAL_RULE.has(name)) {
        applyMatchingStyleDeclarations(content, document, element, declarations)
      }
    } else if (
      splitCssList(block.prelude).some((selector) => matchingElements(document, selector).includes(element))
    ) {
      const probe = document.createElement('div')
      probe.setAttribute('style', directDeclarations(content))
      declarations.push(probe.style)
    }
    cursor = close + 1
    block = nextCssBlock(source, cursor)
  }
}

function matchingStyleDeclarations(document: Document, element: Element): CSSStyleDeclaration[] {
  const declarations: CSSStyleDeclaration[] = []
  document.querySelectorAll('style').forEach((style) => {
    applyMatchingStyleDeclarations(style.textContent ?? '', document, element, declarations)
  })
  return declarations
}

function spansDocument(element: HTMLElement): boolean {
  const width = (element.style.width || element.getAttribute('width') || '').toLowerCase().replace(/\s/g, '')
  return width === '100%'
}

function nonZeroMargin(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return Boolean(normalized && normalized !== 'auto' && !/^0(?:[a-z%]+)?$/.test(normalized))
}

function constrainsNaturalWidth(style: CSSStyleDeclaration): boolean {
  const width = style.width.trim().toLowerCase().replace(/\s/g, '')
  if (width && width !== 'auto' && width !== '100%') return true
  const maxWidth = style.maxWidth.trim().toLowerCase().replace(/\s/g, '')
  if (maxWidth && maxWidth !== 'none' && maxWidth !== '100%') return true
  const display = style.display.trim().toLowerCase()
  if (display.startsWith('inline') || display === 'contents') return true
  const float = style.float.trim().toLowerCase()
  if (float && float !== 'none') return true
  return nonZeroMargin(style.marginLeft) || nonZeroMargin(style.marginRight)
}

function hasWidthConstraint(document: Document, element: HTMLElement): boolean {
  return (
    constrainsNaturalWidth(element.style) ||
    matchingStyleDeclarations(document, element).some(constrainsNaturalWidth)
  )
}

function isFixedWidth(value: string): boolean {
  const normalized = value.trim().toLowerCase().replace(/\s/g, '')
  return Boolean(
    normalized &&
      !normalized.includes('%') &&
      !['auto', 'initial', 'inherit', 'unset', 'revert', 'revert-layer'].includes(normalized)
  )
}

function hasFixedWidth(document: Document, element: HTMLElement): boolean {
  return (
    isFixedWidth(element.getAttribute('width') ?? '') ||
    isFixedWidth(element.style.width) ||
    matchingStyleDeclarations(document, element).some((style) => isFixedWidth(style.width))
  )
}

function stylesheetWinnerCreatesCanvas(elementWinners: BackgroundWinners | undefined): boolean {
  return Boolean(
    elementWinners &&
      BACKGROUND_LONGHANDS.some((longhand) => {
        const winner = elementWinners[longhand]
        return Boolean(
          winner &&
            !winner.inline &&
            winner.order >= 0 &&
            backgroundCreatesCanvas(winner.sourceProperty, winner.value)
        )
      })
  )
}

const NATURAL_FULL_WIDTH = new Set(['DIV', 'SECTION', 'MAIN', 'ARTICLE', 'HEADER', 'FOOTER'])
const NON_CONTENT = new Set(['STYLE', 'LINK', 'META', 'TITLE', 'SCRIPT'])

function ownsOuterCanvas(document: Document, winners: Map<Element, BackgroundWinners>): boolean {
  // DOMPurify sanitizes mail as a fragment, so canvas attributes on source
  // html/body wrappers do not reach the iframe. Stylesheet rules targeting the
  // reconstructed wrappers survive and can establish an outer canvas.
  if (
    stylesheetWinnerCreatesCanvas(winners.get(document.documentElement)) ||
    stylesheetWinnerCreatesCanvas(winners.get(document.body))
  ) {
    return true
  }

  const hasDirectText = [...document.body.childNodes].some((node) => {
    return node.nodeType === 3 && Boolean(node.textContent?.trim())
  })
  if (hasDirectText) return false
  const content = [...document.body.children].filter((element) => !NON_CONTENT.has(element.tagName))
  if (content.length !== 1) return false
  const outer = content[0] as HTMLElement
  const fullWidth =
    !hasWidthConstraint(document, outer) && (NATURAL_FULL_WIDTH.has(outer.tagName) || spansDocument(outer))
  if (!fullWidth) return false
  if (winnersCreateCanvas(winners.get(outer))) return true

  if (outer.tagName !== 'TABLE' || !spansDocument(outer)) return false
  const firstCell = outer.querySelector<HTMLElement>(':scope > tbody > tr > td, :scope > tr > td')
  return Boolean(firstCell && winnersCreateCanvas(winners.get(firstCell)))
}

function hasCenteredOuterCanvas(document: Document): boolean {
  const hasDirectText = [...document.body.childNodes].some((node) => {
    return node.nodeType === 3 && Boolean(node.textContent?.trim())
  })
  if (hasDirectText) return false
  const content = [...document.body.children].filter((element) => !NON_CONTENT.has(element.tagName))
  return content.length === 1 && hasFixedWidth(document, content[0] as HTMLElement)
}

function removeElementBackgrounds(root: ParentNode): void {
  root.querySelectorAll<HTMLElement>('[bgcolor], [background], [style]').forEach((element) => {
    element.removeAttribute('bgcolor')
    element.removeAttribute('background')
    const style = cssDeclarations(element.getAttribute('style') ?? '')
      .filter(({ property }) => !property.startsWith('background'))
      .map(({ raw }) => raw)
      .join('; ')
    if (style) element.setAttribute('style', style)
    else element.removeAttribute('style')
  })
}

/** Remove inline canvases while preserving light-theme typography and foreground colours. */
export function normalizeNativeMailBackgrounds(root: ParentNode): void {
  removeElementBackgrounds(root)
}

/** Remove sender canvases and adapt foreground colours for Attn's native dark surface. */
export function normalizeNativeMailDocument(root: ParentNode): void {
  root.querySelectorAll('style').forEach((style) => {
    style.remove()
  })
  removeElementBackgrounds(root)
  root.querySelectorAll<HTMLElement>('[style]').forEach((element) => {
    const color = element.style.getPropertyValue('color')
    if (!color) return
    const priority = element.style.getPropertyPriority('color')
    const adjusted = nativeTextColor(color)
    if (adjusted) element.style.setProperty('color', adjusted, priority)
    else element.style.removeProperty('color')
    if (!element.getAttribute('style')?.trim()) element.removeAttribute('style')
  })
  root.querySelectorAll<HTMLElement>('font[color]').forEach((element) => {
    const adjusted = nativeTextColor(element.getAttribute('color') ?? '')
    element.removeAttribute('color')
    if (adjusted) element.style.setProperty('color', adjusted)
  })
}

/**
 * Most HTML mail reads cleanly on Attn's native dark canvas once sender colours
 * and backgrounds are normalized. Typography, media, tables, dimensions, and
 * layout do not require a white document. Keep the light canvas only when the
 * sender authored a non-neutral background or background image whose removal
 * would change the meaning of the document.
 */
export function mailPresentationForHtml(html: string | null): MailPresentation {
  if (!html?.trim()) return { surface: 'native', layout: 'padded' }
  const document = new DOMParser().parseFromString(html, 'text/html')
  document.querySelectorAll(SIGNATURE).forEach((element) => {
    element.remove()
  })
  normalizeAppleMailLineBackgrounds(document)

  // Keep quoted content in the document while resolving stylesheet selectors.
  // A real canvas in a forward still belongs to the visible message, even when
  // the matching style block lives outside the quoted wrapper.
  const winners = authoredBackgrounds(document)
  const surface = hasAuthoredCanvas(winners) || hasAuthoredFrame(document) ? 'light' : 'native'
  const layout =
    surface !== 'light'
      ? 'padded'
      : ownsOuterCanvas(document, winners)
        ? 'full-bleed'
        : hasCenteredOuterCanvas(document)
          ? 'centered'
          : 'padded'
  return { surface, layout }
}

/**
 * HTML mail is rendered on an intentionally light canvas. Chromium evaluates
 * sender-authored color-scheme media queries against the dark host app, so
 * disable only the dark branch while leaving light and responsive rules intact.
 */
export function forceLightMailCss(css: string): string {
  return css.replace(EVERY_DARK_COLOR_SCHEME, ALWAYS_FALSE_LIGHT_MEDIA_FEATURE)
}

/** Snapshot applicable stylesheet declarations before a clipboard import removes stylesheets. */
export function inlineClipboardStylesheets(document: Document): void {
  type Declaration = {
    text: string
    important: boolean
    inline: boolean
    specificity: Specificity
    layer: number
  }
  const layers = new Map<string, number>()
  const layerIndex = (name: string): number => {
    if (!layers.has(name)) layers.set(name, layers.size)
    return layers.get(name) ?? 0
  }
  const matched = new Map<Element, Declaration[]>()
  const add = (
    element: Element,
    css: string,
    specificity: Specificity,
    inline = false,
    layer = Number.MAX_SAFE_INTEGER
  ): void => {
    const declarations = matched.get(element) ?? []
    for (const { property, value } of cssDeclarations(css)) {
      declarations.push({
        text: `${property}: ${value.replace(IMPORTANT, '')}`,
        important: IMPORTANT.test(value),
        inline,
        specificity,
        layer
      })
    }
    matched.set(element, declarations)
  }
  type Scope = { root: Element; limit: string | null }
  const visit = (css: string, layerName = '', scopes: Scope[] = []): void => {
    const source = css.replace(CSS_COMMENT, '')
    for (const order of source.matchAll(/@layer\s+([^;{}]+);/g)) {
      for (const name of order[1].split(',')) layerIndex((layerName ? `${layerName}.` : '') + name.trim())
    }
    let block = nextCssBlock(source, 0)
    while (block) {
      const close = matchingBlockEnd(source, block.open)
      if (close < 0) break
      const content = source.slice(block.open + 1, close)
      const atRule = /^@([\w-]+)\b([\s\S]*)$/i.exec(block.prelude)
      if (atRule) {
        const name = atRule[1].toLowerCase()
        const condition = atRule[2].trim()
        if (
          name === 'media' &&
          (typeof window.matchMedia === 'function'
            ? window.matchMedia(condition).matches
            : lightScreenMediaCanApply(condition))
        )
          visit(content, layerName, scopes)
        if (name === 'supports' && typeof CSS !== 'undefined' && CSS.supports(condition))
          visit(content, layerName, scopes)
        if (name === 'scope') {
          const start = condition.startsWith('(') ? matchingDelimiterEnd(condition, 0, '(', ')') : -1
          const rootSelector = start < 0 ? 'body' : condition.slice(1, start)
          const tail = start < 0 ? condition : condition.slice(start + 1).trim()
          const limit = /^to\s*\(([\s\S]*)\)$/.exec(tail)?.[1] ?? null
          try {
            for (const root of document.querySelectorAll(rootSelector))
              visit(content, layerName, [...scopes, { root, limit }])
          } catch {
            /* Invalid selectors have no matching scope. */
          }
        }
        if (name === 'layer') {
          const childLayer = (layerName ? `${layerName}.` : '') + (condition || `anonymous-${layers.size}`)
          layerIndex(childLayer)
          visit(content, childLayer, scopes)
        }
      } else {
        for (const selector of splitCssList(block.prelude)) {
          let elements: NodeListOf<Element>
          try {
            elements = document.querySelectorAll(selector)
          } catch {
            continue
          }
          for (const element of elements) {
            if (
              !scopes.every(({ root, limit }) => {
                if (!root.contains(element)) return false
                let ancestor: Element | null = element
                while (ancestor && ancestor !== root) {
                  if (limit && ancestor.matches(limit)) return false
                  ancestor = ancestor.parentElement
                }
                return true
              })
            )
              continue
            add(
              element,
              directDeclarations(content),
              selectorSpecificity(selector),
              false,
              layerName ? layerIndex(layerName) : Number.MAX_SAFE_INTEGER
            )
          }
        }
      }
      block = nextCssBlock(source, close + 1)
    }
  }
  for (const style of document.querySelectorAll('style')) visit(style.textContent ?? '')
  for (const [element, declarations] of matched) {
    add(element, element.getAttribute('style') ?? '', [0, 0, 0], true)
    declarations.sort(
      (left, right) =>
        Number(left.important) - Number(right.important) ||
        Number(left.inline) - Number(right.inline) ||
        (left.important ? right.layer - left.layer : left.layer - right.layer) ||
        compareSpecificity(left.specificity, right.specificity)
    )
    element.setAttribute('style', declarations.map(({ text }) => text).join('; '))
  }
  for (const style of document.querySelectorAll('style')) style.remove()
}

/** Resolve inherited custom properties while their definitions still exist. */
export function resolveClipboardVariables(document: Document): void {
  const inherited = new Map<Element, Map<string, string>>()
  const substitute = (
    value: string,
    variables: Map<string, string>,
    visiting: Set<string>
  ): string | null => {
    let result = value
    let match = /var\s*\(/i.exec(result)
    let expansions = 0
    while (match) {
      if (++expansions > 100) return null
      const open = match.index + match[0].length - 1
      const close = matchingDelimiterEnd(result, open, '(', ')')
      const args = result.slice(open + 1, close)
      const comma = args.indexOf(',')
      const name = (comma < 0 ? args : args.slice(0, comma)).trim()
      const fallback = comma < 0 ? null : args.slice(comma + 1).trim()
      const raw = variables.get(name)
      const next = new Set(visiting).add(name)
      let replacement = raw !== undefined && !visiting.has(name) ? substitute(raw, variables, next) : null
      if (replacement === null && fallback !== null) replacement = substitute(fallback, variables, visiting)
      if (replacement === null) return null
      result = result.slice(0, match.index) + replacement + result.slice(close + 1)
      match = /var\s*\(/i.exec(result)
    }
    return result
  }
  for (const element of document.querySelectorAll('*')) {
    const variables = new Map(element.parentElement ? inherited.get(element.parentElement) : undefined)
    const declarations = cssDeclarations(element.getAttribute('style') ?? '')
    for (const { property, value } of declarations) {
      if (!property.startsWith('--')) continue
      const keyword = value.replace(IMPORTANT, '').trim().toLowerCase()
      if (keyword === 'initial') variables.delete(property)
      else if (['inherit', 'unset', 'revert', 'revert-layer'].includes(keyword)) {
        const parentValue = element.parentElement
          ? inherited.get(element.parentElement)?.get(property)
          : undefined
        if (parentValue === undefined) variables.delete(property)
        else variables.set(property, parentValue)
      } else variables.set(property, value)
    }
    const computedVariables = new Map<string, string>()
    for (const [name, value] of variables) {
      const computed = substitute(value, variables, new Set([name]))
      if (computed !== null) computedVariables.set(name, computed)
    }
    inherited.set(element, computedVariables)
    const resolved: string[] = []
    for (const { property, value } of declarations) {
      if (property.startsWith('--')) continue
      const substituted = substitute(value, variables, new Set())
      if (substituted !== null) resolved.push(`${property}: ${substituted}`)
    }
    if (resolved.length) element.setAttribute('style', resolved.join('; '))
    else element.removeAttribute('style')
  }
}
