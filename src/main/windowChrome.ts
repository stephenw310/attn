import type { BrowserWindowConstructorOptions, TitleBarOverlayOptions } from 'electron'
import { resolveTheme, type ThemePreference, themeAppearance } from '../shared/theme'

export const TITLE_BAR_HEIGHT = 44
export const MAC_TRAFFIC_LIGHT_POSITION = { x: 12, y: 16 } as const

type WindowChromeOptions = Pick<
  BrowserWindowConstructorOptions,
  'titleBarOverlay' | 'titleBarStyle' | 'trafficLightPosition'
>

export function titleBarOverlayOptions(
  preference: ThemePreference,
  prefersDark: boolean
): TitleBarOverlayOptions {
  const appearance = themeAppearance(resolveTheme(preference, prefersDark))
  return {
    color: '#00000000',
    symbolColor: appearance === 'dark' ? '#9da2ac' : '#555b66',
    height: TITLE_BAR_HEIGHT
  }
}

export function windowChromeOptions(
  platform: NodeJS.Platform,
  preference: ThemePreference,
  prefersDark: boolean
): WindowChromeOptions {
  if (platform === 'darwin') {
    return {
      titleBarStyle: 'hiddenInset',
      titleBarOverlay: true,
      trafficLightPosition: MAC_TRAFFIC_LIGHT_POSITION
    }
  }
  return {
    titleBarStyle: 'hidden',
    titleBarOverlay: titleBarOverlayOptions(preference, prefersDark)
  }
}
