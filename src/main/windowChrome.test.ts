import { describe, expect, it } from 'vitest'
import { TITLE_BAR_HEIGHT, titleBarOverlayOptions, windowChromeOptions } from './windowChrome'

describe('window chrome', () => {
  it('keeps native macOS traffic lights over a full-height content window', () => {
    expect(windowChromeOptions('darwin', 'dispatch-dark', true)).toEqual({
      titleBarStyle: 'hiddenInset',
      titleBarOverlay: true
    })
  })

  it('uses a transparent native-controls overlay on Windows and Linux', () => {
    const expected = {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: '#9da2ac',
        height: TITLE_BAR_HEIGHT
      }
    }
    expect(windowChromeOptions('win32', 'dispatch-dark', true)).toEqual(expected)
    expect(windowChromeOptions('linux', 'dispatch-dark', true)).toEqual(expected)
  })

  it('keeps overlay symbols legible when the app theme changes', () => {
    expect(titleBarOverlayOptions('dispatch-light', true).symbolColor).toBe('#555b66')
    expect(titleBarOverlayOptions('dispatch-dark', false).symbolColor).toBe('#9da2ac')
    expect(titleBarOverlayOptions('system', false).symbolColor).toBe('#555b66')
    expect(titleBarOverlayOptions('system', true).symbolColor).toBe('#9da2ac')
  })
})
