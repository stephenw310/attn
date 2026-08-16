import { describe, expect, it, vi } from 'vitest'
import type { Db } from '../db'
import { undoSendDelayMs } from './queue'

function settingsDb(value: string | undefined): Db {
  return {
    prepare: vi.fn(() => ({ get: vi.fn(() => (value === undefined ? undefined : { value })) }))
  } as unknown as Db
}

describe('undo send setting', () => {
  it('defaults to eight seconds and accepts only supported explicit values', () => {
    expect(undoSendDelayMs(settingsDb(undefined))).toBe(8_000)
    expect(undoSendDelayMs(settingsDb('20'))).toBe(20_000)
    expect(undoSendDelayMs(settingsDb('0'))).toBe(0)
    expect(undoSendDelayMs(settingsDb('7'))).toBe(8_000)
    expect(undoSendDelayMs(settingsDb('not-a-number'))).toBe(8_000)
  })
})
