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
 * The compile-time historical sync limit (F2, §9 #22). `sync/tuning.ts`
 * re-exports these as `LIFETIME_THREAD_CAP` / `LIFETIME_THREAD_CAP_UNLIMITED`;
 * they live here so the renderer's settings surface labels the same numbers
 * the sweep enforces, with no second literal.
 */
export const DEFAULT_LIFETIME_THREAD_CAP = 400_000
export const LIFETIME_THREAD_CAP_ALL_MAIL = 0

/**
 * Account-scoped preferences (F18 rule 9): each carries the owning account
 * id through the bridge, and the utility rejects a write whose account is no
 * longer active, so a late completion cannot land on a newly selected
 * account's controls.
 */
/** The exact optional footer line (F6). Plain text — no link, image, or tracking. */
export const ATTN_SIGNATURE_LINE = 'Sent with Attn'

export interface AccountSettings {
  /**
   * Historical sync limit override (F2, §9 #22): conversations of additional
   * historical header fetching to allow. `null` means the compile-time
   * default applies; `0` means All mail. It bounds only the lifetime sweep —
   * lowering it deletes nothing, and inbox sync, new mail, server search,
   * and on-demand reads still add rows.
   */
  lifetimeThreadCap: number | null
  /**
   * Include the "Sent with Attn" footer when creating a local draft (F6).
   * Default off; the preference affects new drafts only — open, saved, and
   * queued drafts keep exactly the body the user last saw.
   */
  attnSignatureEnabled: boolean
}

export type AccountSettingKey = keyof AccountSettings

export type AccountSettingUpdate = {
  [K in AccountSettingKey]: { key: K; value: AccountSettings[K] }
}[AccountSettingKey]

export function validateAccountSettingUpdate(key: unknown, value: unknown): AccountSettingUpdate {
  switch (key) {
    case 'lifetimeThreadCap': {
      // Reject negatives, fractions, invalid strings, and unsafe integers in
      // the handler too — the UI's own validation is not a boundary.
      if (value !== null && (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)) {
        throw new Error('invalid historical sync limit')
      }
      return { key, value }
    }
    case 'attnSignatureEnabled': {
      if (typeof value !== 'boolean') throw new Error('invalid attnSignatureEnabled value')
      return { key, value }
    }
    default:
      throw new Error('unknown account setting')
  }
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
