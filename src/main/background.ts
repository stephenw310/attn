import { app, BrowserWindow, Menu, Tray } from 'electron'
import trayIcon from '../../resources/tray.png?asset'
import type { Db } from './db'

type CreateWindow = (options?: { show?: boolean }) => BrowserWindow

const APP_SETTINGS_ACCOUNT_ID = '__app__'

let createMainWindow: CreateWindow | null = null
let quitting = false
let showOnInitialize = false
let tray: Tray | null = null

function readSetting(db: Db, key: string): string | undefined {
  const row = db
    .prepare('SELECT value FROM settings WHERE account_id = ? AND key = ?')
    .get(APP_SETTINGS_ACCOUNT_ID, key) as { value: string } | undefined
  return row?.value
}

function writeSetting(db: Db, key: string, value: string): void {
  db.prepare('INSERT OR REPLACE INTO settings (account_id, key, value) VALUES (?, ?, ?)').run(
    APP_SETTINGS_ACCOUNT_ID,
    key,
    value
  )
}

function settingEnabled(db: Db, key: string, defaultValue: boolean): boolean {
  const value = readSetting(db, key)
  return value === undefined ? defaultValue : value === 'true'
}

function hiddenLoginLaunch(): boolean {
  if (process.argv.includes('--hidden')) return true
  return process.platform === 'darwin' && app.isPackaged && app.getLoginItemSettings().wasOpenedAtLogin
}

function installLoginItem(db: Db): void {
  if (!app.isPackaged) return
  // Register once. After that the OS-level toggle (Task Manager, System
  // Settings) belongs to the user — re-asserting on every boot would silently
  // undo a disable made there. The in-app setting re-runs this when it lands.
  if (readSetting(db, 'loginItemRegistered') !== undefined) return
  const openAtLogin = settingEnabled(db, 'launchAtLogin', true)
  app.setLoginItemSettings({
    openAtLogin,
    args: process.platform === 'win32' && openAtLogin ? ['--hidden'] : []
  })
  writeSetting(db, 'loginItemRegistered', 'true')
}

function installTray(): void {
  if (process.platform !== 'win32' || tray) return
  tray = new Tray(trayIcon)
  tray.setToolTip('Attn')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open Inbox', click: () => showMainWindow() },
      { label: 'Compose (M2)', enabled: false },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])
  )
  tray.on('double-click', () => showMainWindow())
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

export function initializeBackground(db: Db, createWindow: CreateWindow): { startHidden: boolean } {
  createMainWindow = createWindow
  installLoginItem(db)
  installTray()
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
  createMainWindow = null
})
