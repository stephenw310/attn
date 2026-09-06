import { EventEmitter } from 'node:events'
import { app, type BrowserWindow, Menu, Tray } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return {
    app: Object.assign(new EventEmitter(), {
      isPackaged: false,
      dock: { hide: vi.fn(), show: vi.fn().mockResolvedValue(undefined), isVisible: vi.fn(() => false) },
      quit: vi.fn()
    }),
    BrowserWindow: { getAllWindows: vi.fn() },
    Menu: { buildFromTemplate: vi.fn((items) => items) },
    nativeImage: {
      createFromPath: () => ({ resize: () => ({ setTemplateImage: vi.fn() }) })
    },
    Tray: vi.fn(function (this: Record<string, unknown>) {
      Object.assign(this, { destroy: vi.fn(), setToolTip: vi.fn(), setContextMenu: vi.fn(), on: vi.fn() })
    })
  }
})
vi.mock('../../resources/menuBarTemplate.png?asset', () => ({ default: 'menu.png' }))
vi.mock('../../resources/tray.png?asset', () => ({ default: 'tray.png' }))

const platform = process.platform
const argv = process.argv
const dock = app.dock
if (!dock) throw new Error('Mock Dock missing')
const effects = { markLoginItemRegistered: vi.fn(), setNotificationPausedUntil: vi.fn() }
const settings = { launchAtLogin: false, loginItemRegistered: true, menuBarIcon: false }

function windowStub() {
  return Object.assign(new EventEmitter(), {
    hide: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
    isDestroyed: () => false,
    isVisible: () => true
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetModules()
  vi.clearAllMocks()
  vi.mocked(dock.show).mockResolvedValue(undefined)
  vi.mocked(dock.isVisible).mockReturnValue(false)
  app.removeAllListeners()
  Object.defineProperty(process, 'platform', { value: 'darwin' })
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform })
  process.argv = argv
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('close to background', () => {
  it('keeps a menu bar control while closed, restores the Dock, and honors the open-window preference', async () => {
    const background = await import('./background')
    background.initializeBackground(settings, effects, vi.fn())
    const win = windowStub()
    background.attachBackgroundWindow(win as unknown as BrowserWindow)
    expect(Tray).not.toHaveBeenCalled()

    const event = { preventDefault: vi.fn() }
    win.emit('close', event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(win.hide).toHaveBeenCalledOnce()
    expect(dock.hide).toHaveBeenCalledOnce()
    const tray = vi.mocked(Tray).mock.instances[0]
    expect(tray.setContextMenu).toHaveBeenCalled()
    background.applyMenuBarIcon(false, effects)
    expect(tray.destroy).not.toHaveBeenCalled()

    background.showBackgroundWindow(win as unknown as BrowserWindow)
    await Promise.resolve()
    expect(dock.show).toHaveBeenCalledOnce()
    expect(win.focus).toHaveBeenCalledOnce()
    expect(tray.destroy).toHaveBeenCalledOnce()

    background.applyMenuBarIcon(true, effects)
    const persistentTray = vi.mocked(Tray).mock.instances[1]
    win.emit('close', event)
    background.showBackgroundWindow(win as unknown as BrowserWindow)
    await Promise.resolve()
    expect(persistentTray.destroy).not.toHaveBeenCalled()
    background.applyMenuBarIcon(false, effects)
    expect(persistentTray.destroy).toHaveBeenCalledOnce()
  })

  it('does not let an unfinished Dock show undo another close', async () => {
    const background = await import('./background')
    background.initializeBackground(settings, effects, vi.fn())
    const win = windowStub()
    background.attachBackgroundWindow(win as unknown as BrowserWindow)
    let finishShow: () => void = () => {}
    vi.mocked(dock.show).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishShow = resolve
        })
    )
    background.showBackgroundWindow(win as unknown as BrowserWindow)
    win.emit('close', { preventDefault: vi.fn() })
    finishShow()
    await Promise.resolve()
    expect(dock.hide).toHaveBeenCalledTimes(2)
    expect(win.focus).not.toHaveBeenCalled()
  })

  it('retries Electron’s ignored rapid Dock hide and cancels the retry on reopen or quit', async () => {
    const background = await import('./background')
    background.initializeBackground(settings, effects, vi.fn())
    const win = windowStub()
    background.attachBackgroundWindow(win as unknown as BrowserWindow)
    vi.mocked(dock.isVisible).mockReturnValue(true)
    win.emit('close', { preventDefault: vi.fn() })
    expect(dock.hide).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1_100)
    expect(dock.hide).toHaveBeenCalledTimes(2)

    win.emit('close', { preventDefault: vi.fn() })
    background.showBackgroundWindow(win as unknown as BrowserWindow)
    await vi.advanceTimersByTimeAsync(1_100)
    expect(dock.hide).toHaveBeenCalledTimes(3)
    win.emit('close', { preventDefault: vi.fn() })
    app.emit('before-quit', { preventDefault: vi.fn() })
    await vi.advanceTimersByTimeAsync(1_100)
    expect(dock.hide).toHaveBeenCalledTimes(4)
    vi.mocked(dock.isVisible).mockReturnValue(false)
  })

  it('starts hidden with a menu bar control and lets explicit quit close the window', async () => {
    process.argv = ['electron', '--hidden']
    const background = await import('./background')
    expect(background.initializeBackground(settings, effects, vi.fn())).toEqual({ startHidden: true })
    expect(dock.hide).toHaveBeenCalledOnce()
    expect(Tray).toHaveBeenCalledOnce()
    const menu = vi.mocked(Menu.buildFromTemplate).mock.calls[0][0]
    const quit = menu.find((item) => item.label === 'Quit')
    expect(quit).toBeDefined()
    // Invoke the real tray action, then deliver Electron's quit lifecycle.
    quit?.click?.({} as Electron.MenuItem, undefined, {} as Electron.KeyboardEvent)
    expect(app.quit).toHaveBeenCalledOnce()
    app.emit('before-quit', { preventDefault: vi.fn() })
    const win = windowStub()
    background.attachBackgroundWindow(win as unknown as BrowserWindow)
    const event = { preventDefault: vi.fn() }
    win.emit('close', event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    expect(win.hide).not.toHaveBeenCalled()
    app.emit('will-quit', { preventDefault: vi.fn() })
    expect(vi.mocked(Tray).mock.instances[0].destroy).toHaveBeenCalledOnce()
  })

  it('keeps Windows close-to-tray behavior without touching the Dock', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const background = await import('./background')
    background.initializeBackground(settings, effects, vi.fn())
    const win = windowStub()
    background.attachBackgroundWindow(win as unknown as BrowserWindow)
    const event = { preventDefault: vi.fn() }
    win.emit('close', event)
    expect(event.preventDefault).toHaveBeenCalledOnce()
    expect(win.hide).toHaveBeenCalledOnce()
    expect(Tray).toHaveBeenCalledOnce()
    expect(dock.hide).not.toHaveBeenCalled()
  })
})
