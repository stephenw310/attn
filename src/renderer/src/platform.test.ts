import { afterEach, expect, test, vi } from 'vitest'
import { formatShortcut } from './platform'

afterEach(() => vi.unstubAllGlobals())

test('formats Mac shortcuts with spaced symbols and preserves chords', () => {
  vi.stubGlobal('window', { attn: { platform: 'darwin' } })
  expect(formatShortcut('Mod+Shift+k')).toBe('⌘ ⇧ K')
  expect(formatShortcut('Mod+Alt+Enter')).toBe('⌘ ⌥ Enter')
  expect(formatShortcut('g i')).toBe('G I')
})

test('formats Windows shortcuts with spaced named modifiers', () => {
  vi.stubGlobal('window', { attn: { platform: 'win32' } })
  expect(formatShortcut('Mod+Shift+k')).toBe('Ctrl Shift K')
  expect(formatShortcut('Escape')).toBe('Esc')
})
