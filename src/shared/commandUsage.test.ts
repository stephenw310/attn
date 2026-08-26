import { describe, expect, it } from 'vitest'
import { COMMAND_USAGE_LIMIT, parseStoredCommandUsage, sanitizeCommandUsage } from './commandUsage'

describe('command usage', () => {
  it('keeps valid entries newest first and enforces the storage bound', () => {
    const input = Object.fromEntries(
      Array.from({ length: COMMAND_USAGE_LIMIT + 5 }, (_, index) => [
        `command.${index}`,
        { count: index + 1, lastUsedAt: 1_000 + index }
      ])
    )

    const sanitized = sanitizeCommandUsage(input)
    expect(Object.keys(sanitized)).toHaveLength(COMMAND_USAGE_LIMIT)
    expect(Object.keys(sanitized).at(0)).toBe(`command.${COMMAND_USAGE_LIMIT + 4}`)
    expect(sanitized['command.0']).toBeUndefined()
  })

  it('drops malformed entries and treats invalid stored JSON as empty', () => {
    expect(
      sanitizeCommandUsage({
        valid: { count: 2, lastUsedAt: 123 },
        zero: { count: 0, lastUsedAt: 123 },
        futureFloat: { count: 1, lastUsedAt: 1.5 },
        '=formula': { count: 1, lastUsedAt: 123 }
      })
    ).toEqual({ valid: { count: 2, lastUsedAt: 123 } })
    expect(parseStoredCommandUsage('{broken')).toEqual({})
  })
})
