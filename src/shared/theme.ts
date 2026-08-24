export const THEME_IDS = ['dispatch-dark', 'dispatch-light', 'midnight', 'sand'] as const

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
  { id: 'dispatch-light', label: 'Light', appearance: 'light' },
  { id: 'midnight', label: 'Midnight', appearance: 'dark' },
  { id: 'sand', label: 'Sand', appearance: 'light' }
]

export function isThemePreference(value: unknown): value is ThemePreference {
  return value === 'system' || THEME_IDS.some((theme) => theme === value)
}

export function resolveTheme(preference: ThemePreference, prefersDark: boolean): ThemeId {
  if (preference !== 'system') return preference
  return prefersDark ? 'dispatch-dark' : 'dispatch-light'
}

export function themeAppearance(theme: ThemeId): ThemeAppearance {
  return theme === 'dispatch-dark' || theme === 'midnight' ? 'dark' : 'light'
}
