import CounterStyle, { type CounterStyleRenderer } from '@jsamr/counter-style'
import arabicIndic from '@jsamr/counter-style/presets/arabicIndic'
import armenian from '@jsamr/counter-style/presets/armenian'
import bengali from '@jsamr/counter-style/presets/bengali'
import cambodian from '@jsamr/counter-style/presets/cambodian'
import circle from '@jsamr/counter-style/presets/circle'
import cjkDecimal from '@jsamr/counter-style/presets/cjkDecimal'
import cjkEarthlyBranch from '@jsamr/counter-style/presets/cjkEarthlyBranch'
import cjkHeavenlyStem from '@jsamr/counter-style/presets/cjkHeavenlyStem'
import decimal from '@jsamr/counter-style/presets/decimal'
import decimalLeadingZero from '@jsamr/counter-style/presets/decimalLeadingZero'
import devanagari from '@jsamr/counter-style/presets/devanagari'
import disc from '@jsamr/counter-style/presets/disc'
import georgian from '@jsamr/counter-style/presets/georgian'
import gujarati from '@jsamr/counter-style/presets/gujarati'
import gurmukhi from '@jsamr/counter-style/presets/gurmukhi'
import hebrew from '@jsamr/counter-style/presets/hebrew'
import hiragana from '@jsamr/counter-style/presets/hiragana'
import hiraganaIroha from '@jsamr/counter-style/presets/hiraganaIroha'
import japaneseFormal from '@jsamr/counter-style/presets/japaneseFormal'
import japaneseInformal from '@jsamr/counter-style/presets/japaneseInformal'
import kannada from '@jsamr/counter-style/presets/kannada'
import katana from '@jsamr/counter-style/presets/katana'
import katanaIroha from '@jsamr/counter-style/presets/katanaIroha'
import khmer from '@jsamr/counter-style/presets/khmer'
import koreanHangulFormal from '@jsamr/counter-style/presets/koreanHangulFormal'
import koreanHanjaFormal from '@jsamr/counter-style/presets/koreanHanjaFormal'
import koreanHanjaInformal from '@jsamr/counter-style/presets/koreanHanjaInformal'
import lao from '@jsamr/counter-style/presets/lao'
import lowerAlpha from '@jsamr/counter-style/presets/lowerAlpha'
import lowerArmenian from '@jsamr/counter-style/presets/lowerArmenian'
import lowerLatin from '@jsamr/counter-style/presets/lowerLatin'
import lowerRoman from '@jsamr/counter-style/presets/lowerRoman'
import malayalam from '@jsamr/counter-style/presets/malayalam'
import mongolian from '@jsamr/counter-style/presets/mongolian'
import myanmar from '@jsamr/counter-style/presets/myanmar'
import oriya from '@jsamr/counter-style/presets/oriya'
import persian from '@jsamr/counter-style/presets/persian'
import square from '@jsamr/counter-style/presets/square'
import tamil from '@jsamr/counter-style/presets/tamil'
import telugu from '@jsamr/counter-style/presets/telugu'
import thai from '@jsamr/counter-style/presets/thai'
import tibetan from '@jsamr/counter-style/presets/tibetan'
import upperAlpha from '@jsamr/counter-style/presets/upperAlpha'
import upperArmenian from '@jsamr/counter-style/presets/upperArmenian'
import upperLatin from '@jsamr/counter-style/presets/upperLatin'
import upperRoman from '@jsamr/counter-style/presets/upperRoman'
import { cssDeclarations } from '../../../shared/css'

// The CSS alphabet omits final sigma, so it is not a contiguous Unicode range.
const lowerGreek = CounterStyle.alphabetic(...'αβγδεζηθικλμνξοπρστυφχψω')

const presets: Record<string, CounterStyleRenderer> = {
  'arabic-indic': arabicIndic,
  armenian: armenian,
  bengali: bengali,
  cambodian: cambodian,
  circle: circle,
  'cjk-decimal': cjkDecimal,
  'cjk-earthly-branch': cjkEarthlyBranch,
  'cjk-heavenly-stem': cjkHeavenlyStem,
  decimal: decimal,
  'decimal-leading-zero': decimalLeadingZero,
  devanagari: devanagari,
  disc: disc,
  georgian: georgian,
  gujarati: gujarati,
  gurmukhi: gurmukhi,
  hebrew: hebrew,
  hiragana: hiragana,
  'hiragana-iroha': hiraganaIroha,
  'japanese-formal': japaneseFormal,
  'japanese-informal': japaneseInformal,
  kannada: kannada,
  katakana: katana,
  'katakana-iroha': katanaIroha,
  khmer: khmer,
  'korean-hangul-formal': koreanHangulFormal,
  'korean-hanja-formal': koreanHanjaFormal,
  'korean-hanja-informal': koreanHanjaInformal,
  lao: lao,
  'lower-alpha': lowerAlpha,
  'lower-armenian': lowerArmenian,
  'lower-greek': lowerGreek,
  'lower-latin': lowerLatin,
  'lower-roman': lowerRoman,
  malayalam: malayalam,
  mongolian: mongolian,
  myanmar: myanmar,
  oriya: oriya,
  persian: persian,
  square: square,
  tamil: tamil,
  telugu: telugu,
  thai: thai,
  tibetan: tibetan,
  'upper-alpha': upperAlpha,
  'upper-armenian': upperArmenian,
  'upper-latin': upperLatin,
  'upper-roman': upperRoman
}

export function formatClipboardCounter(value: number, style = 'decimal'): string {
  return (presets[style] ?? decimal).renderCounter(value)
}

/** Compile author-defined counter systems from the isolated frame's parsed CSS. */
export function createClipboardCounterFormatter(
  document: Document
): (value: number, style?: string, customMarker?: boolean) => string {
  const definitions = new Map<string, Map<string, string>>()
  const collect = (rules: CSSRuleList): void => {
    for (const rule of rules) {
      if (rule.type === 4 && !document.defaultView?.matchMedia((rule as CSSMediaRule).conditionText).matches)
        continue
      if (rule.type === 12 && !CSS.supports((rule as CSSSupportsRule).conditionText)) continue
      if (rule.type === 11) {
        const named = rule as CSSRule & { name: string }
        const body = rule.cssText.slice(rule.cssText.indexOf('{') + 1, rule.cssText.lastIndexOf('}'))
        definitions.set(
          named.name,
          new Map(cssDeclarations(body).map(({ property, value }) => [property, value]))
        )
      } else if ('cssRules' in rule) collect((rule as CSSGroupingRule).cssRules)
    }
  }
  for (const sheet of document.styleSheets) collect(sheet.cssRules)
  const symbols = (value: string): string[] =>
    (value.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,]+/g) ?? []).map((token) => {
      const text = /^['"]/.test(token) ? token.slice(1, -1) : token
      return text.replace(
        /\\([0-9a-f]{1,6})\s?|\\(.)/gi,
        (_match, hex: string | undefined, character: string) =>
          hex ? String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)) : character
      )
    })
  const built = new Map<string, CounterStyleRenderer>()
  const build = (name: string, visiting = new Set<string>()): CounterStyleRenderer => {
    if (built.has(name)) return built.get(name) ?? decimal
    const definition = definitions.get(name)
    if (!definition || visiting.has(name)) return presets[name] ?? decimal
    const next = new Set(visiting).add(name)
    const [system, argument] = (definition.get('system') ?? 'symbolic').split(/\s+/)
    const values = symbols(definition.get('symbols') ?? '')
    let renderer: CounterStyleRenderer = decimal
    if (system === 'extends') renderer = build(argument, next)
    else if (system === 'additive') {
      const tuples: Record<number, string> = {}
      for (const tuple of (definition.get('additive-symbols') ?? '').split(',')) {
        const [weight, symbol] = symbols(tuple)
        if (symbol !== undefined && Number.isFinite(Number(weight))) tuples[Number(weight)] = symbol
      }
      if (Object.keys(tuples).length) renderer = CounterStyle.additive(tuples)
    } else if (values.length) {
      if (system === 'fixed') {
        const start = argument === undefined ? 1 : Number(argument)
        renderer = CounterStyle.raw((value) => values[value - start]).withRange(
          start,
          start + values.length - 1
        )
      } else if (['cyclic', 'symbolic', 'alphabetic', 'numeric'].includes(system)) {
        renderer = CounterStyle[system as 'cyclic' | 'symbolic' | 'alphabetic' | 'numeric'](...values)
      }
    }
    const negative = symbols(definition.get('negative') ?? '')
    if (negative.length) renderer = renderer.withNegative(negative[0], negative[1])
    const pad = symbols(definition.get('pad') ?? '')
    if (pad.length === 2) renderer = renderer.withPadLeft(Number(pad[0]), pad[1])
    const fallback = definition.get('fallback')
    if (fallback) renderer = renderer.withFallback(build(fallback, next))
    const range = definition.get('range')
    if (range && range !== 'auto') {
      const ranges = range.split(',').map((pair) =>
        pair
          .trim()
          .split(/\s+/)
          .map((part) => (part === 'infinite' ? Infinity : part === '-infinite' ? -Infinity : Number(part)))
      )
      const original = renderer
      const alternative = build(fallback ?? 'decimal', next)
      renderer = Object.create(original) as CounterStyleRenderer
      renderer.renderCounter = (value) =>
        ranges.some(([min, max]) => value >= min && value <= max)
          ? original.renderCounter(value)
          : alternative.renderCounter(value)
    }
    built.set(name, renderer)
    return renderer
  }
  return (value, name = 'decimal', customMarker = false) => {
    if (!customMarker) return build(name).renderCounter(value)
    if (!definitions.has(name)) return ''
    const descriptor = (key: string, current = name, visited = new Set<string>()): string | undefined => {
      if (visited.has(current)) return undefined
      visited.add(current)
      const definition = definitions.get(current)
      const value = definition?.get(key)
      if (value !== undefined) return value
      const system = definition?.get('system')?.split(/\s+/)
      return system?.[0] === 'extends' ? descriptor(key, system[1], visited) : undefined
    }
    return `${symbols(descriptor('prefix') ?? '""').join('')}${build(name).renderCounter(value)}${symbols(descriptor('suffix') ?? '". "').join('')}`
  }
}
