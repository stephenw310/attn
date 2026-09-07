import { describe, expect, it } from 'vitest'
import {
  MAC_TRAFFIC_LIGHT_POSITION,
  TITLE_BAR_HEIGHT,
  titleBarOverlayOptions,
  windowChromeOptions
} from './windowChrome'

describe('window chrome', () => {
  it('uses a compact title bar that matches native control alignment', () => {
    expect(TITLE_BAR_HEIGHT).toBe(44)
  })

  it('keeps native macOS traffic lights over a full-height content window', () => {
    expect(MAC_TRAFFIC_LIGHT_POSITION).toEqual({ x: 12, y: 14 })
    expect(windowChromeOptions('darwin', 'dispatch-dark', true)).toEqual({
      titleBarStyle: 'hiddenInset',
      titleBarOverlay: true,
      trafficLightPosition: MAC_TRAFFIC_LIGHT_POSITION
    })
  })

  it('uses a transparent native-controls overlay on Windows and Linux', () => {
    const expected = {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: '#b8b2a5',
        height: TITLE_BAR_HEIGHT
      }
    }
    expect(windowChromeOptions('win32', 'dispatch-dark', true)).toEqual(expected)
    expect(windowChromeOptions('linux', 'dispatch-dark', true)).toEqual(expected)
  })

  it('keeps overlay symbols legible when the app theme changes', () => {
    expect(titleBarOverlayOptions('dispatch-light', true).symbolColor).toBe('#54432f')
    expect(titleBarOverlayOptions('dispatch-dark', false).symbolColor).toBe('#b8b2a5')
    expect(titleBarOverlayOptions('system', false).symbolColor).toBe('#54432f')
    expect(titleBarOverlayOptions('system', true).symbolColor).toBe('#b8b2a5')
  })
})
