import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  normalizePalette,
  PALETTE_OPTIONS,
  type PaletteId,
  resolveTheme,
  THEME_OPTIONS,
  type ThemeAppearance,
  type ThemeId,
  type ThemePreference,
  themeAppearance
} from '../../shared/theme'
import { createCommand, registerCommands } from './commands'

interface ThemeContextValue {
  palette: PaletteId
  setPalette: (palette: PaletteId) => void
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
const initialPalette = normalizePalette(window.attn?.settings.initialPalette)
document.documentElement.dataset.palette = initialPalette

function applyTheme(theme: ThemeId): void {
  const root = document.documentElement
  const appearance = themeAppearance(theme)
  root.dataset.theme = theme
  root.dataset.themeAppearance = appearance
  root.style.colorScheme = appearance
}

applyTheme(initialTheme)

const ThemeContext = createContext<ThemeContextValue>({
  palette: initialPalette,
  setPalette: () => {},
  appearance: themeAppearance(initialTheme),
  preference: initialPreference,
  resolvedTheme: initialTheme,
  setPreference: () => {}
})

export function ThemeProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [palette, setPaletteState] = useState<PaletteId>(initialPalette)
  const [paletteError, setPaletteError] = useState<string | null>(null)
  const paletteSequence = useRef(0)
  const pendingPaletteWrite = useRef(Promise.resolve())
  const savedPalette = useRef<PaletteId>(initialPalette)
  useLayoutEffect(() => {
    document.documentElement.dataset.palette = palette
  }, [palette])
  useEffect(() => {
    let stale = false
    const sequence = paletteSequence.current
    void window.attn?.settings
      .getAll()
      .then((settings) => {
        if (stale || sequence !== paletteSequence.current) return
        savedPalette.current = normalizePalette(settings.palette)
        setPaletteState(savedPalette.current)
      })
      .catch(() => {
        if (!stale) setPaletteError('Could not load color palette')
      })
    return () => {
      stale = true
    }
  }, [])
  const setPalette = useCallback((next: PaletteId) => {
    const sequence = ++paletteSequence.current
    setPaletteState(next)
    setPaletteError(null)
    pendingPaletteWrite.current = pendingPaletteWrite.current
      .then(() => window.attn?.settings.set('palette', next))
      .then((settings) => {
        if (!settings) return
        savedPalette.current = settings.palette
        if (sequence === paletteSequence.current) setPaletteState(settings.palette)
      })
      .catch(() => {
        if (sequence !== paletteSequence.current) return
        setPaletteState(savedPalette.current)
        setPaletteError('Color palette could not be saved')
      })
  }, [])
  useLayoutEffect(
    () =>
      registerCommands(
        PALETTE_OPTIONS.map((option) =>
          createCommand(`palette.${option.id}` as const, () => setPalette(option.id))
        )
      ),
    [setPalette]
  )
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
      palette,
      setPalette,
      appearance: themeAppearance(resolvedTheme),
      preference,
      resolvedTheme,
      setPreference
    }),
    [palette, setPalette, preference, resolvedTheme, setPreference]
  )

  return (
    <ThemeContext.Provider value={value}>
      {children}
      {paletteError && (
        <div role="alert" className="app-preference-error">
          {paletteError}
          <button type="button" className="app-button" onClick={() => setPaletteError(null)}>
            Dismiss
          </button>
        </div>
      )}
    </ThemeContext.Provider>
  )
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext)
}
