import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron'
import menuBarTemplate from '../../resources/menuBarTemplate.png?asset'
import trayIcon from '../../resources/tray.png?asset'
import { oneHourFrom, tomorrowStart } from '../shared/notifications'
import { loginItemSettingsFor } from './backgroundSettings'
import { type SchedulerTime, systemTime, type TimerHandle } from './time'

type CreateWindow = (options?: { show?: boolean }) => BrowserWindow

let createMainWindow: CreateWindow | null = null
let quitting = false
let showOnInitialize = false
let tray: Tray | null = null
let macMenuBarTray: Tray | null = null
let backgroundEffects: BackgroundEffects | null = null
let menuBarIcon = false
let macBackgrounded = false
let backgroundTime = systemTime
let dockHideRetry: TimerHandle | null = null

// Electron's Browser::DockHide ignores hides within one second of DockShow
// to avoid duplicate macOS Dock icons. Leave a small margin before retrying.
const DOCK_HIDE_RETRY_MS = 1_100

function hiddenLoginLaunch(): boolean {
  if (process.argv.includes('--hidden')) return true
  return process.platform === 'darwin' && app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin
}

export interface BackgroundSettings {
  launchAtLogin: boolean
  loginItemRegistered: boolean
  /** Keep the macOS menu-bar icon visible while the window is open; default off. */
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

export function applyMenuBarIcon(visible: boolean, effects: BackgroundEffects): void {
  menuBarIcon = visible
  backgroundEffects = effects
  refreshMenuBarIcon()
}

function refreshMenuBarIcon(): void {
  if (process.platform !== 'darwin') return
  if (!menuBarIcon && !macBackgrounded) {
    macMenuBarTray?.destroy()
    macMenuBarTray = null
    return
  }
  if (macMenuBarTray || !backgroundEffects) return
  const icon = nativeImage.createFromPath(menuBarTemplate).resize({ width: 16, height: 16 })
  icon.setTemplateImage(true)
  macMenuBarTray = new Tray(icon)
  macMenuBarTray.setToolTip('Attn')
  macMenuBarTray.setContextMenu(trayMenu(backgroundEffects))
}

function enterMacBackground(): void {
  macBackgrounded = true
  // Install the reopen control before removing the Dock entry.
  refreshMenuBarIcon()
  hideMacDock()
}

function cancelDockHideRetry(): void {
  if (dockHideRetry !== null) backgroundTime.timers.clearTimeout(dockHideRetry)
  dockHideRetry = null
}

function hideMacDock(): void {
  app.dock?.hide()
  if (!app.dock?.isVisible() || dockHideRetry !== null) return
  dockHideRetry = backgroundTime.timers.setTimeout(() => {
    dockHideRetry = null
    if (macBackgrounded && !quitting) app.dock?.hide()
  }, DOCK_HIDE_RETRY_MS)
}

export function attachBackgroundWindow(win: BrowserWindow): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return
  win.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    win.hide()
    if (process.platform === 'darwin') enterMacBackground()
  })
}

export function showBackgroundWindow(win: BrowserWindow): void {
  if (process.platform === 'darwin') {
    macBackgrounded = false
    cancelDockHideRetry()
    refreshMenuBarIcon()
    // Native show events can arrive after a subsequent close on macOS.
    // Restore the Dock explicitly and check that the window is still wanted.
    void app.dock
      ?.show()
      .then(() => {
        if (quitting || win.isDestroyed()) return
        if (macBackgrounded) hideMacDock()
        else {
          win.show()
          win.focus()
        }
      })
      .catch((error: unknown) => console.error('[background] could not restore Dock icon', error))
    return
  }
  win.show()
  win.focus()
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
  showBackgroundWindow(win)
  return win
}

export function initializeBackground(
  settings: BackgroundSettings,
  effects: BackgroundEffects,
  createWindow: CreateWindow,
  time: SchedulerTime = systemTime
): { startHidden: boolean } {
  backgroundTime = time
  createMainWindow = createWindow
  installLoginItem(settings, effects)
  installTray(effects)
  applyMenuBarIcon(settings.menuBarIcon, effects)
  const startHidden = hiddenLoginLaunch() && !showOnInitialize
  if (process.platform === 'darwin' && startHidden) enterMacBackground()
  showOnInitialize = false
  return { startHidden }
}

app.on('before-quit', () => {
  quitting = true
  cancelDockHideRetry()
})

app.on('will-quit', () => {
  tray?.destroy()
  tray = null
  macMenuBarTray?.destroy()
  macMenuBarTray = null
  createMainWindow = null
})
