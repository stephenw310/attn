export const THEME_IDS = ['dispatch-dark', 'dispatch-light'] as const

export type ThemeId = (typeof THEME_IDS)[number]
export type ThemePreference = 'system' | ThemeId
export type ThemeAppearance = 'dark' | 'light'

export interface ThemeOption {
  id: ThemePreference
  label: string
  appearance: ThemeAppearance | 'system'
}

export const THEME_OPTIONS: readonly ThemeOption[] = [
  { id: 'system', label: 'System', appearance: 'system' },
  { id: 'dispatch-dark', label: 'Dark', appearance: 'dark' },
  { id: 'dispatch-light', label: 'Light', appearance: 'light' }
]

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || THEME_IDS.some((theme) => theme === value)
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ThemeId {
  if (preference !== 'system') return preference
  return prefersDark ? 'dispatch-dark' : 'dispatch-light'
}

export function themeAppearance(theme: ThemeId): ThemeAppearance {
  return theme === 'dispatch-dark' ? 'dark' : 'light'
}

/** Preserve the appearance of retired saved palettes without accepting new writes. */
export function normalizeThemePreference(value: unknown): ThemePreference {
  if (value === 'midnight') return 'dispatch-dark'
  if (value === 'sand') return 'dispatch-light'
  return isThemePreference(value) ? value : 'system'
}
