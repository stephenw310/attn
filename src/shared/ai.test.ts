import { describe, expect, it } from 'vitest'
import { validateAiSettingUpdate } from './ai'

describe('validateAiSettingUpdate', () => {
  it('allows plain HTTP only for a loopback endpoint', () => {
    // The bearer key travels on this URL, so HTTP is acceptable only when the
    // request never leaves the machine (Ollama, LM Studio).
    for (const value of [
      'http://localhost:11434/v1',
      'http://127.0.0.1:1234/v1',
      'http://[::1]:1234/v1',
      'https://api.example.com/v1'
    ]) {
      expect(validateAiSettingUpdate('baseUrl', value)).toEqual({ key: 'baseUrl', value })
    }
    for (const value of [
      'http://api.example.com/v1',
      'http://localhost.example.com/v1',
      'http://192.168.1.10:1234/v1'
    ]) {
      expect(() => validateAiSettingUpdate('baseUrl', value)).toThrow(/https except on localhost/)
    }
  })

  it('still rejects a non-HTTP scheme and an unparsable URL', () => {
    expect(() => validateAiSettingUpdate('baseUrl', 'file:///etc/passwd')).toThrow(/invalid AI base URL/)
    expect(() => validateAiSettingUpdate('baseUrl', 'not a url')).toThrow(/invalid AI base URL/)
    expect(validateAiSettingUpdate('baseUrl', null)).toEqual({ key: 'baseUrl', value: null })
  })
})
