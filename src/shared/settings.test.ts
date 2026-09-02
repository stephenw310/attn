import { describe, expect, it } from 'vitest'
import { ALLOWED_UNDO_SEND_SECONDS } from './outboxTuning'
import { validateAppSettingUpdate } from './settings'

describe('validateAppSettingUpdate', () => {
  it('accepts every allowed undo-send delay and nothing else', () => {
    for (const seconds of ALLOWED_UNDO_SEND_SECONDS) {
      expect(validateAppSettingUpdate('undoSendDelaySeconds', seconds)).toEqual({
        key: 'undoSendDelaySeconds',
        value: seconds
      })
    }
    expect(() => validateAppSettingUpdate('undoSendDelaySeconds', 7)).toThrow('invalid undo-send delay')
    expect(() => validateAppSettingUpdate('undoSendDelaySeconds', '5')).toThrow('invalid undo-send delay')
    expect(() => validateAppSettingUpdate('undoSendDelaySeconds', Number.NaN)).toThrow(
      'invalid undo-send delay'
    )
  })

  it('accepts only the three auto-advance directions', () => {
    for (const direction of ['next', 'previous', 'list'] as const) {
      expect(validateAppSettingUpdate('autoAdvanceDirection', direction)).toEqual({
        key: 'autoAdvanceDirection',
        value: direction
      })
    }
    expect(() => validateAppSettingUpdate('autoAdvanceDirection', 'up')).toThrow(
      'invalid auto-advance direction'
    )
    expect(() => validateAppSettingUpdate('autoAdvanceDirection', true)).toThrow(
      'invalid auto-advance direction'
    )
  })

  it('requires booleans for the background toggles', () => {
    expect(validateAppSettingUpdate('launchAtLogin', false)).toEqual({ key: 'launchAtLogin', value: false })
    expect(validateAppSettingUpdate('menuBarIcon', true)).toEqual({ key: 'menuBarIcon', value: true })
    expect(validateAppSettingUpdate('unreadBadgeEnabled', false)).toEqual({
      key: 'unreadBadgeEnabled',
      value: false
    })
    expect(() => validateAppSettingUpdate('launchAtLogin', 'true')).toThrow('invalid launchAtLogin value')
    expect(() => validateAppSettingUpdate('menuBarIcon', 1)).toThrow('invalid menuBarIcon value')
    expect(() => validateAppSettingUpdate('unreadBadgeEnabled', 1)).toThrow(
      'invalid unreadBadgeEnabled value'
    )
  })

  it('accepts a finite future deadline or null for the notification pause', () => {
    expect(validateAppSettingUpdate('notificationsPausedUntil', null)).toEqual({
      key: 'notificationsPausedUntil',
      value: null
    })
    expect(validateAppSettingUpdate('notificationsPausedUntil', 1_756_600_000_000)).toEqual({
      key: 'notificationsPausedUntil',
      value: 1_756_600_000_000
    })
    expect(() => validateAppSettingUpdate('notificationsPausedUntil', Number.POSITIVE_INFINITY)).toThrow(
      'invalid notification pause'
    )
    expect(() => validateAppSettingUpdate('notificationsPausedUntil', -5)).toThrow(
      'invalid notification pause'
    )
    expect(() => validateAppSettingUpdate('notificationsPausedUntil', undefined)).toThrow(
      'invalid notification pause'
    )
  })

  it('rejects unknown keys so the bridge cannot write arbitrary settings', () => {
    expect(() => validateAppSettingUpdate('theme', 'midnight')).toThrow('unknown setting')
    expect(() => validateAppSettingUpdate('seedAccountIds', '[]')).toThrow('unknown setting')
    expect(() => validateAppSettingUpdate(42, true)).toThrow('unknown setting')
  })
})
