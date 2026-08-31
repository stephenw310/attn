// Utility-process storage for the app-global AI configuration (T36, F17/F18
// rule 9). Rows live in the plaintext `settings` table under the app
// sentinel — they hold toggles, provider choice, and the voice profile, and
// may NEVER hold the provider key (that is safeStorage-encrypted in a file
// owned by main). Writes go through the shared allowlist validator.

import {
  AI_SETTINGS_DEFAULTS,
  type AiSettingUpdate,
  type AiStoredSettings,
  isAiProviderKind,
  isAiVoiceTone
} from '../shared/ai'
import type { Db } from './db'
import { deleteSetting, readSetting, settingEnabled, writeSetting } from './settings'

const KEYS: Record<keyof AiStoredSettings, string> = {
  enabled: 'aiEnabled',
  autocompleteEnabled: 'aiAutocompleteEnabled',
  provider: 'aiProvider',
  baseUrl: 'aiBaseUrl',
  model: 'aiModel',
  voiceTone: 'aiVoiceTone',
  voiceRules: 'aiVoiceRules',
  voiceMatchingEnabled: 'aiVoiceMatching'
}

export function readAiStoredSettings(db: Db): AiStoredSettings {
  const provider = readSetting(db, KEYS.provider)
  const voiceTone = readSetting(db, KEYS.voiceTone)
  return {
    enabled: settingEnabled(db, KEYS.enabled, AI_SETTINGS_DEFAULTS.enabled),
    autocompleteEnabled: settingEnabled(
      db,
      KEYS.autocompleteEnabled,
      AI_SETTINGS_DEFAULTS.autocompleteEnabled
    ),
    provider: isAiProviderKind(provider) ? provider : AI_SETTINGS_DEFAULTS.provider,
    baseUrl: readSetting(db, KEYS.baseUrl) ?? AI_SETTINGS_DEFAULTS.baseUrl,
    model: readSetting(db, KEYS.model) ?? AI_SETTINGS_DEFAULTS.model,
    voiceTone: isAiVoiceTone(voiceTone) ? voiceTone : AI_SETTINGS_DEFAULTS.voiceTone,
    voiceRules: readSetting(db, KEYS.voiceRules) ?? AI_SETTINGS_DEFAULTS.voiceRules,
    voiceMatchingEnabled: settingEnabled(
      db,
      KEYS.voiceMatchingEnabled,
      AI_SETTINGS_DEFAULTS.voiceMatchingEnabled
    )
  }
}

/** Persist one validated write; a default value removes its row. */
export function writeAiStoredSetting(db: Db, update: AiSettingUpdate): AiStoredSettings {
  const storageKey = KEYS[update.key]
  if (update.value === AI_SETTINGS_DEFAULTS[update.key] || update.value === null) {
    deleteSetting(db, storageKey)
  } else {
    writeSetting(db, storageKey, String(update.value))
  }
  return readAiStoredSettings(db)
}
