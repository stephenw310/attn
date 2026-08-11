import { app, BrowserWindow, Menu, Tray } from 'electron'
import trayIcon from '../../resources/tray.png?asset'
import type { Db } from './db'

type CreateWindow = (options?: { show?: boolean }) => BrowserWindow

let createMainWindow: CreateWindow | null = null
let quitting = false
let tray: Tray | null = null

function settingEnabled(db: Db, key: string, defaultValue: boolean): boolean {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
  return row ? row.value === 'true' : defaultValue
}

function hiddenLoginLaunch(): boolean {
  if (process.argv.includes('--hidden')) return true
  return process.platform === 'darwin' && app.isPackaged && app.getLoginItemSettings().wasOpenedAsHidden
}

function installLoginItem(db: Db): void {
  if (!app.isPackaged) return
  const openAtLogin = settingEnabled(db, 'launchAtLogin', true)
  app.setLoginItemSettings({
    openAtLogin,
    openAsHidden: openAtLogin,
    args: process.platform === 'win32' && openAtLogin ? ['--hidden'] : []
  })
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
  let win = BrowserWindow.getAllWindows()[0]
  if (!win && createMainWindow) win = createMainWindow({ show: true })
  if (!win) return null
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  return win
}

export function initializeBackground(db: Db, createWindow: CreateWindow): { startHidden: boolean } {
  createMainWindow = createWindow
  installLoginItem(db)
  installTray()
  return { startHidden: hiddenLoginLaunch() }
}

app.on('before-quit', () => {
  quitting = true
})

app.on('will-quit', () => {
  tray?.destroy()
  tray = null
  createMainWindow = null
})
