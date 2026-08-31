// Typed app-settings contract shared by main, the utility process, and the
// renderer (SPEC F15). Every key the generic settings bridge may read or write
// is declared here with its value type; anything else is rejected at the IPC
// boundary, so the bridge can never become a path to arbitrary setting names
// (F15 implementation guide). Storage stays in the utility's `settings` table;
// main applies OS effects (login item, macOS menu-bar icon) after a write.

import { ALLOWED_UNDO_SEND_SECONDS, DEFAULT_UNDO_SEND_SECONDS } from './outboxTuning'

export const AUTO_ADVANCE_DIRECTIONS = ['next', 'previous', 'list'] as const

/** Where triage lands after done/snooze/trash removes the current row (F3). */
export type AutoAdvanceDirection = (typeof AUTO_ADVANCE_DIRECTIONS)[number]

export function isAutoAdvanceDirection(value: unknown): value is AutoAdvanceDirection {
  return AUTO_ADVANCE_DIRECTIONS.includes(value as AutoAdvanceDirection)
}

export const AUTO_ADVANCE_LABELS: Record<AutoAdvanceDirection, string> = {
  next: 'Next conversation',
  previous: 'Previous conversation',
  list: 'Back to list'
}

/**
 * The app-global preferences the settings surface exposes (F15, F18 rule 9:
 * all of these apply to every signed-in account). Account-scoped preferences
 * (T32A's sync limit, T32B's footer) ride their own typed reads keyed by the
 * owning account rather than this snapshot.
 */
export interface AppSettings {
  undoSendDelaySeconds: number
  autoAdvanceDirection: AutoAdvanceDirection
  /** F16: default on; ordinary launches still respect an OS-side disable. */
  launchAtLogin: boolean
  /** F16: optional macOS menu-bar icon, default off. */
  menuBarIcon: boolean
  /** Epoch ms all notifications stay paused until; null = not paused (F12). */
  notificationsPausedUntil: number | null
}

export type AppSettingKey = keyof AppSettings

export type AppSettingUpdate = {
  [K in AppSettingKey]: { key: K; value: AppSettings[K] }
}[AppSettingKey]

export const APP_SETTINGS_DEFAULTS: AppSettings = {
  undoSendDelaySeconds: DEFAULT_UNDO_SEND_SECONDS,
  autoAdvanceDirection: 'next',
  launchAtLogin: true,
  menuBarIcon: false,
  notificationsPausedUntil: null
}

/**
 * Narrow one settings write to the allowlist. Both ends of the bridge run
 * this: main before forwarding (so OS effects only ever follow a valid write)
 * and the utility before touching SQLite (the renderer is untrusted).
 */
export function validateAppSettingUpdate(key: unknown, value: unknown): AppSettingUpdate {
  switch (key) {
    case 'undoSendDelaySeconds': {
      if (typeof value !== 'number' || !ALLOWED_UNDO_SEND_SECONDS.has(value)) {
        throw new Error('invalid undo-send delay')
      }
      return { key, value }
    }
    case 'autoAdvanceDirection': {
      if (!isAutoAdvanceDirection(value)) throw new Error('invalid auto-advance direction')
      return { key, value }
    }
    case 'launchAtLogin':
    case 'menuBarIcon': {
      if (typeof value !== 'boolean') throw new Error(`invalid ${key} value`)
      return { key, value }
    }
    case 'notificationsPausedUntil': {
      if (value !== null && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) {
        throw new Error('invalid notification pause')
      }
      return { key, value }
    }
    default:
      throw new Error('unknown setting')
  }
}
