// Utility-process storage for the app-global AI configuration (T36, F17/F18
// rule 9). Rows live in the plaintext `settings` table under the app
// sentinel — they hold toggles, provider choice, the voice profile, and the
// smart-splits consent, and may NEVER hold either key (the writing provider
// key and the TypeSafe key are safeStorage-encrypted in separate files owned
// by main). Writes go through the shared allowlist validator.

import {
  AI_SETTINGS_DEFAULTS,
  type AiSettingUpdate,
  type AiStoredSettings,
  isAiProviderKind,
  isAiVoiceTone
} from '../shared/ai'
import type { Db } from './db'
import { type TypedSetting, typedSetting } from './settings'

const asBoolean = (raw: string): boolean => raw === 'true'
const asText = (raw: string): string => raw

/**
 * One typed row per setting, each carrying its own default. `typedSetting`
 * owns the "writing a default deletes its row" rule, so an absent row always
 * means the default — the same rule the app settings use.
 */
const SETTINGS: { [K in keyof AiStoredSettings]: TypedSetting<AiStoredSettings[K]> } = {
  enabled: typedSetting('aiEnabled', AI_SETTINGS_DEFAULTS.enabled, asBoolean),
  autocompleteEnabled: typedSetting(
    'aiAutocompleteEnabled',
    AI_SETTINGS_DEFAULTS.autocompleteEnabled,
    asBoolean
  ),
  provider: typedSetting('aiProvider', AI_SETTINGS_DEFAULTS.provider, (raw) =>
    isAiProviderKind(raw) ? raw : undefined
  ),
  baseUrl: typedSetting('aiBaseUrl', AI_SETTINGS_DEFAULTS.baseUrl, asText),
  model: typedSetting('aiModel', AI_SETTINGS_DEFAULTS.model, asText),
  voiceTone: typedSetting('aiVoiceTone', AI_SETTINGS_DEFAULTS.voiceTone, (raw) =>
    isAiVoiceTone(raw) ? raw : undefined
  ),
  voiceRules: typedSetting('aiVoiceRules', AI_SETTINGS_DEFAULTS.voiceRules, asText),
  voiceMatchingEnabled: typedSetting('aiVoiceMatching', AI_SETTINGS_DEFAULTS.voiceMatchingEnabled, asBoolean),
  triageEnabled: typedSetting('aiTriageEnabled', AI_SETTINGS_DEFAULTS.triageEnabled, asBoolean),
  triageModel: typedSetting('aiTriageModel', AI_SETTINGS_DEFAULTS.triageModel, asText)
}

export function readAiStoredSettings(db: Db): AiStoredSettings {
  return {
    enabled: SETTINGS.enabled.read(db),
    autocompleteEnabled: SETTINGS.autocompleteEnabled.read(db),
    provider: SETTINGS.provider.read(db),
    baseUrl: SETTINGS.baseUrl.read(db),
    model: SETTINGS.model.read(db),
    voiceTone: SETTINGS.voiceTone.read(db),
    voiceRules: SETTINGS.voiceRules.read(db),
    voiceMatchingEnabled: SETTINGS.voiceMatchingEnabled.read(db),
    triageEnabled: SETTINGS.triageEnabled.read(db),
    triageModel: SETTINGS.triageModel.read(db)
  }
}

/** Persist one validated write; a default value removes its row. */
export function writeAiStoredSetting(db: Db, update: AiSettingUpdate): AiStoredSettings {
  // The update is a discriminated union over these same keys, so the row and
  // the value always agree; the cast only says so to TypeScript.
  const setting = SETTINGS[update.key] as TypedSetting<AiSettingUpdate['value']>
  // Clearing an override (null) means "follow the default", which is the row
  // removal `typedSetting` already performs for a default value.
  setting.write(db, update.value === null ? AI_SETTINGS_DEFAULTS[update.key] : update.value)
  return readAiStoredSettings(db)
}
