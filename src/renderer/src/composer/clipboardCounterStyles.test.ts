import { expect, it } from 'vitest'
import { formatClipboardCounter } from './clipboardCounterStyles'

it('formats non-Latin and alphabetic CSS counters without substituting decimal digits', () => {
  expect(formatClipboardCounter(1, 'lower-greek')).toBe('α')
  expect(formatClipboardCounter(24, 'lower-greek')).toBe('ω')
  expect(formatClipboardCounter(25, 'lower-greek')).toBe('αα')
  expect(formatClipboardCounter(12, 'arabic-indic')).toBe('١٢')
  expect(formatClipboardCounter(4, 'hebrew')).toBe('ד')
  expect(formatClipboardCounter(12, 'upper-roman')).toBe('XII')
})
