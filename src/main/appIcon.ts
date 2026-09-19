import { app, BrowserWindow } from 'electron'
import duskIcon from '../../resources/icon-dusk.png?asset'
import linenIcon from '../../resources/icon-linen.png?asset'
import matchaIcon from '../../resources/icon-matcha.png?asset'
import mistIcon from '../../resources/icon-mist.png?asset'
import type { PaletteId } from '../shared/theme'

/**
 * Palette-aware app icons are separate raster assets so Electron can use the
 * same exact pixels for BrowserWindow and the macOS Dock. The source shape is
 * unchanged; only its ground, mark, and tab colors vary by palette.
 */
const ICON_PATHS: Record<PaletteId, string> = {
  matcha: matchaIcon,
  mist: mistIcon,
  linen: linenIcon,
  dusk: duskIcon
}

export function appIconPath(palette: PaletteId): string {
  return ICON_PATHS[palette]
}

/** Apply the saved palette to already-created native surfaces. */
export function applyAppIcon(palette: PaletteId): void {
  const icon = appIconPath(palette)
  if (process.platform === 'darwin') {
    app.dock?.setIcon(icon)
    return
  }
  for (const win of BrowserWindow.getAllWindows()) win.setIcon(icon)
}
