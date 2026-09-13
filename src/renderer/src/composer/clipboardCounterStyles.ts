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
