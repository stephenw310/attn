import { describe, expect, it } from 'vitest'
import { isThemePreference, resolveTheme, THEME_IDS, themeAppearance } from './theme'

describe('theme preferences', () => {
  it('maps the System preference to the Dispatch pair', () => {
    expect(resolveTheme('system', true)).toBe('dispatch-dark')
    expect(resolveTheme('system', false)).toBe('dispatch-light')
  })

  it('keeps named palettes pinned across OS appearance changes', () => {
    for (const theme of THEME_IDS) {
      expect(resolveTheme(theme, true)).toBe(theme)
      expect(resolveTheme(theme, false)).toBe(theme)
    }
  })

  it('records the appearance used by mail rendering and native controls', () => {
    expect(themeAppearance('dispatch-dark')).toBe('dark')
    expect(themeAppearance('midnight')).toBe('dark')
    expect(themeAppearance('dispatch-light')).toBe('light')
    expect(themeAppearance('sand')).toBe('light')
  })

  it('rejects unknown persisted values', () => {
    expect(isThemePreference('system')).toBe(true)
    expect(isThemePreference('midnight')).toBe(true)
    expect(isThemePreference('dark')).toBe(false)
    expect(isThemePreference('custom')).toBe(false)
  })
})
