import { describe, expect, it } from 'vitest'
import { AI_SETTINGS_DEFAULTS } from '../shared/ai'
import { readAiStoredSettings, writeAiStoredSetting } from './aiSettings'
import { type Db, openDatabase } from './db'

function store(): Db {
  return openDatabase(':memory:')
}

describe('AI stored settings', () => {
  it('reads the documented defaults from an empty store', () => {
    expect(readAiStoredSettings(store())).toEqual(AI_SETTINGS_DEFAULTS)
  })

  it('round-trips every field and resets to default by deleting the row', () => {
    const db = store()
    writeAiStoredSetting(db, { key: 'enabled', value: true })
    writeAiStoredSetting(db, { key: 'autocompleteEnabled', value: true })
    writeAiStoredSetting(db, { key: 'provider', value: 'openai-compatible' })
    writeAiStoredSetting(db, { key: 'baseUrl', value: 'http://localhost:1234/v1' })
    writeAiStoredSetting(db, { key: 'model', value: 'my-model' })
    writeAiStoredSetting(db, { key: 'voiceTone', value: 'formal' })
    writeAiStoredSetting(db, { key: 'voiceRules', value: 'no exclamation marks' })
    writeAiStoredSetting(db, { key: 'voiceMatchingEnabled', value: true })
    expect(readAiStoredSettings(db)).toEqual({
      enabled: true,
      autocompleteEnabled: true,
      provider: 'openai-compatible',
      baseUrl: 'http://localhost:1234/v1',
      model: 'my-model',
      voiceTone: 'formal',
      voiceRules: 'no exclamation marks',
      voiceMatchingEnabled: true
    })
    writeAiStoredSetting(db, { key: 'enabled', value: false })
    writeAiStoredSetting(db, { key: 'model', value: null })
    const reset = readAiStoredSettings(db)
    expect(reset.enabled).toBe(false)
    expect(reset.model).toBeNull()
    expect(db.prepare("SELECT 1 FROM settings WHERE key IN ('aiEnabled', 'aiModel')").all()).toEqual([])
  })

  it('a corrupted provider row falls back to the default provider', () => {
    const db = store()
    db.prepare("INSERT INTO settings (account_id, key, value) VALUES ('__app__', 'aiProvider', 'x')").run()
    expect(readAiStoredSettings(db).provider).toBe(AI_SETTINGS_DEFAULTS.provider)
  })
})
