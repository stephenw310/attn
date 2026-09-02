// Electron-free decisions behind the F15/F16 background settings, split from
// background.ts (which touches `app`/`Tray` at module scope) so they stay
// unit-testable with fake OS adapters.

/**
 * What the OS login-item registration should be for a given preference. Pure
 * so the settings path can be verified with fake adapters: Windows keeps the
 * hidden-launch arguments that make a login start windowless (F16).
 */
export function loginItemSettingsFor(
  platform: NodeJS.Platform,
  openAtLogin: boolean
): { openAtLogin: boolean; args: string[] } {
  return { openAtLogin, args: platform === 'win32' && openAtLogin ? ['--hidden'] : [] }
}

export interface LoginItemAdapter {
  isPackaged: boolean
  setLoginItemSettings: (settings: { openAtLogin: boolean; args: string[] }) => void
}

/**
 * Apply the launch-at-login preference to the OS now (F15). Unlike the
 * one-time boot registration, this runs on every settings change — the
 * `loginItemRegistered` guard exists so ordinary launches respect an OS-side
 * disable, not so the in-app toggle becomes inert. Test and development runs
 * never register real login items (`isPackaged` gate).
 */
export function applyLoginItemSetting(
  enabled: boolean,
  platform: NodeJS.Platform,
  adapter: LoginItemAdapter,
  effects: { markLoginItemRegistered: () => void }
): void {
  if (!adapter.isPackaged) return
  adapter.setLoginItemSettings(loginItemSettingsFor(platform, enabled))
  effects.markLoginItemRegistered()
}
