// Utility-process storage for the typed app-settings bridge (SPEC F15).
// Reads assemble the full snapshot from the `settings` table with the shared
// defaults; writes go through the shared allowlist validator, so the renderer
// can never name an arbitrary settings row. OS effects (login item, menu-bar
// icon) are main's job after the write returns.

import {
  type AccountSettings,
  APP_SETTINGS_DEFAULTS,
  type AppSettings,
  type AppSettingUpdate,
  isAutoAdvanceDirection,
  validateAppSettingUpdate
} from '../shared/settings'
import type { Db } from './db'
import { undoSendDelayMs } from './outbox/queue'
import { notificationPausedUntil, setNotificationPausedUntil } from './service/notificationQueries'
import { attnSignatureEnabled } from './outbox/sendAs'
import { deleteSetting, readSetting, settingEnabled, writeSetting } from './settings'
import { storedLifetimeThreadCap } from './sync/lifetimeCap'

/** The account-scoped snapshot for the owning account (F18 rule 9). */
export function readAccountSettings(db: Db, accountId: string): AccountSettings {
  return {
    lifetimeThreadCap: storedLifetimeThreadCap(db, accountId),
    attnSignatureEnabled: attnSignatureEnabled(db, accountId)
  }
}

export function readAppSettings(db: Db): AppSettings {
  const autoAdvance = readSetting(db, 'autoAdvanceDirection')
  return {
    // One source of truth with the sender: the same helper the outbox queue
    // uses to time real sends resolves the stored value and its default.
    undoSendDelaySeconds: undoSendDelayMs(db) / 1_000,
    autoAdvanceDirection: isAutoAdvanceDirection(autoAdvance)
      ? autoAdvance
      : APP_SETTINGS_DEFAULTS.autoAdvanceDirection,
    launchAtLogin: settingEnabled(db, 'launchAtLogin', APP_SETTINGS_DEFAULTS.launchAtLogin),
    menuBarIcon: settingEnabled(db, 'menuBarIcon', APP_SETTINGS_DEFAULTS.menuBarIcon),
    notificationsPausedUntil: notificationPausedUntil(db)
  }
}

/** Validate and persist one write; returns the updated snapshot. */
export function writeAppSetting(db: Db, key: unknown, value: unknown): AppSettings {
  const update: AppSettingUpdate = validateAppSettingUpdate(key, value)
  if (update.key === 'notificationsPausedUntil') setNotificationPausedUntil(db, update.value)
  else if (update.value === APP_SETTINGS_DEFAULTS[update.key]) deleteSetting(db, update.key)
  else writeSetting(db, update.key, String(update.value))
  return readAppSettings(db)
}
