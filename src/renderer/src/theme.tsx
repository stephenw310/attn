import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from 'react'
import {
  resolveTheme,
  THEME_OPTIONS,
  type ThemeAppearance,
  type ThemeId,
  type ThemePreference,
  themeAppearance
} from '../../shared/theme'
import { createCommand, registerCommands } from './commands'

interface ThemeContextValue {
  appearance: ThemeAppearance
  preference: ThemePreference
  resolvedTheme: ThemeId
  setPreference: (preference: ThemePreference) => void
}

function prefersDarkAppearance(): boolean {
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true
}

const initialPreference = window.attn?.settings.initialTheme ?? 'system'
const initialTheme = resolveTheme(initialPreference, prefersDarkAppearance())

function applyTheme(theme: ThemeId): void {
  const root = document.documentElement
  const appearance = themeAppearance(theme)
  root.dataset.theme = theme
  root.dataset.themeAppearance = appearance
  root.style.colorScheme = appearance
}

applyTheme(initialTheme)

const ThemeContext = createContext<ThemeContextValue>({
  appearance: themeAppearance(initialTheme),
  preference: initialPreference,
  resolvedTheme: initialTheme,
  setPreference: () => {}
})

export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [preference, setPreferenceState] = useState<ThemePreference>(initialPreference)
  const [prefersDark, setPrefersDark] = useState(prefersDarkAppearance)
  const resolvedTheme = resolveTheme(preference, prefersDark)

  useLayoutEffect(() => applyTheme(resolvedTheme), [resolvedTheme])

  useEffect(() => {
    const darkMedia = window.matchMedia?.('(prefers-color-scheme: dark)')
    if (!darkMedia) return
    const onChange = (event: MediaQueryListEvent): void => setPrefersDark(event.matches)
    darkMedia.addEventListener('change', onChange)
    return () => darkMedia.removeEventListener('change', onChange)
  }, [])

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next)
    void window.attn?.settings.setTheme(next).catch(() => {})
  }, [])

  useLayoutEffect(
    () =>
      registerCommands(
        THEME_OPTIONS.map((option) =>
          createCommand(`theme.${option.id}` as const, () => setPreference(option.id), {
            title: `Use ${option.label} theme`
          })
        )
      ),
    [setPreference]
  )

  const value = useMemo<ThemeContextValue>(
    () => ({
      appearance: themeAppearance(resolvedTheme),
      preference,
      resolvedTheme,
      setPreference
    }),
    [preference, resolvedTheme, setPreference]
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext)
}
