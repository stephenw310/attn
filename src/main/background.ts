import { app, BrowserWindow, Menu, Tray } from 'electron'
import trayIcon from '../../resources/tray.png?asset'
import { loginItemSettingsFor } from './backgroundSettings'
import { oneHourFrom, tomorrowStart } from './notify'

type CreateWindow = (options?: { show?: boolean }) => BrowserWindow

let createMainWindow: CreateWindow | null = null
let quitting = false
let showOnInitialize = false
let tray: Tray | null = null
let macMenuBarTray: Tray | null = null

function hiddenLoginLaunch(): boolean {
  if (process.argv.includes('--hidden')) return true
  return process.platform === 'darwin' && app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin
}

export interface BackgroundSettings {
  launchAtLogin: boolean
  loginItemRegistered: boolean
  /** F16: optional macOS menu-bar icon mirroring the tray menu; default off. */
  menuBarIcon: boolean
}

export interface BackgroundEffects {
  markLoginItemRegistered: () => void
  setNotificationPausedUntil: (pausedUntil: number | null) => void
}

function installLoginItem(settings: BackgroundSettings, effects: BackgroundEffects): void {
  if (!app.isPackaged) return
  // Register once. After that the OS-level toggle (Task Manager, System
  // Settings) belongs to the user — re-asserting on every boot would silently
  // undo a disable made there. The in-app setting runs applyLoginItemSetting.
  if (settings.loginItemRegistered) return
  app.setLoginItemSettings(loginItemSettingsFor(process.platform, settings.launchAtLogin))
  effects.markLoginItemRegistered()
}

function trayMenu(effects: BackgroundEffects): Menu {
  return Menu.buildFromTemplate([
    { label: 'Open Inbox', click: () => showMainWindow() },
    { label: 'Compose (M2)', enabled: false },
    { type: 'separator' },
    {
      label: 'Pause notifications',
      submenu: [
        {
          label: 'For 1 hour',
          click: () => effects.setNotificationPausedUntil(oneHourFrom())
        },
        {
          label: 'Until tomorrow',
          click: () => effects.setNotificationPausedUntil(tomorrowStart())
        },
        { type: 'separator' },
        { label: 'Resume notifications', click: () => effects.setNotificationPausedUntil(null) }
      ]
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ])
}

function installTray(effects: BackgroundEffects): void {
  if (process.platform !== 'win32' || tray) return
  tray = new Tray(trayIcon)
  tray.setToolTip('Attn')
  tray.setContextMenu(trayMenu(effects))
  tray.on('double-click', () => showMainWindow())
}

/**
 * Install or remove the optional macOS menu-bar icon (F16, default off). It
 * mirrors the Windows tray menu; the Windows tray itself is always present
 * and never touched by this toggle. Idempotent so a settings write and boot
 * can both call it.
 */
export function applyMenuBarIcon(visible: boolean, effects: BackgroundEffects): void {
  if (process.platform !== 'darwin') return
  if (!visible) {
    macMenuBarTray?.destroy()
    macMenuBarTray = null
    return
  }
  if (macMenuBarTray) return
  macMenuBarTray = new Tray(trayIcon)
  macMenuBarTray.setToolTip('Attn')
  macMenuBarTray.setContextMenu(trayMenu(effects))
}

export function attachBackgroundWindow(win: BrowserWindow): void {
  if (process.platform !== 'win32') return
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    win.hide()
  })
}

export function showMainWindow(): BrowserWindow | null {
  const win = BrowserWindow.getAllWindows()[0]
  const creator = createMainWindow
  if (!win) {
    if (!creator) {
      showOnInitialize = true
      return null
    }
    // A fresh window reveals itself on ready-to-show; showing it here would
    // flash an unpainted frame — the very thing F16 rules out.
    return creator({ show: true })
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  return win
}

export function initializeBackground(
  settings: BackgroundSettings,
  effects: BackgroundEffects,
  createWindow: CreateWindow
): { startHidden: boolean } {
  createMainWindow = createWindow
  installLoginItem(settings, effects)
  installTray(effects)
  applyMenuBarIcon(settings.menuBarIcon, effects)
  const startHidden = hiddenLoginLaunch() && !showOnInitialize
  showOnInitialize = false
  return { startHidden }
}

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => {
  tray?.destroy()
  tray = null
  macMenuBarTray?.destroy()
  macMenuBarTray = null
  createMainWindow = null
})
