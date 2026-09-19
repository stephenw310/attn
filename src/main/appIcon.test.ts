import { app, BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { appIconPath, applyAppIcon } from './appIcon'

vi.mock('electron', () => ({
  app: { dock: { setIcon: vi.fn() } },
  BrowserWindow: { getAllWindows: vi.fn() }
}))
vi.mock('../../resources/icon-matcha.png?asset', () => ({ default: 'matcha.png' }))
vi.mock('../../resources/icon-mist.png?asset', () => ({ default: 'mist.png' }))
vi.mock('../../resources/icon-linen.png?asset', () => ({ default: 'linen.png' }))
vi.mock('../../resources/icon-dusk.png?asset', () => ({ default: 'dusk.png' }))

const originalPlatform = process.platform

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([])
})

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform })
})

describe('palette app icons', () => {
  it('maps every palette to its bundled icon asset', () => {
    expect(appIconPath('matcha')).toBe('matcha.png')
    expect(appIconPath('mist')).toBe('mist.png')
    expect(appIconPath('linen')).toBe('linen.png')
    expect(appIconPath('dusk')).toBe('dusk.png')
  })

  it('updates the macOS Dock icon without touching the menu-bar asset', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' })
    applyAppIcon('dusk')
    expect(app.dock?.setIcon).toHaveBeenCalledWith('dusk.png')
    expect(BrowserWindow.getAllWindows).not.toHaveBeenCalled()
  })

  it('updates every existing Windows window icon after a palette write', () => {
    Object.defineProperty(process, 'platform', { value: 'win32' })
    const first = { setIcon: vi.fn() }
    const second = { setIcon: vi.fn() }
    vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([first, second] as never)
    applyAppIcon('mist')
    expect(first.setIcon).toHaveBeenCalledWith('mist.png')
    expect(second.setIcon).toHaveBeenCalledWith('mist.png')
    expect(app.dock?.setIcon).not.toHaveBeenCalled()
  })
})
