import { describe, expect, it } from 'vitest'
import { applyLoginItemSetting, loginItemSettingsFor } from './backgroundSettings'

describe('loginItemSettingsFor', () => {
  it('keeps the Windows hidden-launch arguments only while enabled', () => {
    expect(loginItemSettingsFor('win32', true)).toEqual({ openAtLogin: true, args: ['--hidden'] })
    expect(loginItemSettingsFor('win32', false)).toEqual({ openAtLogin: false, args: [] })
    expect(loginItemSettingsFor('darwin', true)).toEqual({ openAtLogin: true, args: [] })
    expect(loginItemSettingsFor('darwin', false)).toEqual({ openAtLogin: false, args: [] })
  })
})

describe('applyLoginItemSetting', () => {
  it('updates the OS registration on every settings change in packaged builds', () => {
    const applied: { openAtLogin: boolean; args: string[] }[] = []
    let marked = 0
    const adapter = {
      isPackaged: true,
      setLoginItemSettings: (settings: { openAtLogin: boolean; args: string[] }) => {
        applied.push(settings)
      }
    }
    const effects = { markLoginItemRegistered: () => marked++ }

    // The one-time boot guard must not make the in-app toggle inert: a
    // disable and a re-enable both reach the OS.
    applyLoginItemSetting(false, 'win32', adapter, effects)
    applyLoginItemSetting(true, 'win32', adapter, effects)
    expect(applied).toEqual([
      { openAtLogin: false, args: [] },
      { openAtLogin: true, args: ['--hidden'] }
    ])
    expect(marked).toBe(2)
  })

  it('never registers real login items in test or development runs', () => {
    let touched = false
    applyLoginItemSetting(
      true,
      'darwin',
      {
        isPackaged: false,
        setLoginItemSettings: () => {
          touched = true
        }
      },
      { markLoginItemRegistered: () => {} }
    )
    expect(touched).toBe(false)
  })
})
