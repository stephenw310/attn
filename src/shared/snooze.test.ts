import { describe, expect, it } from 'vitest'
import { formatSnoozeDate, parseSnoozeText, snoozePresets } from './snooze'

describe('snoozePresets', () => {
  it('computes every preset from the supplied local time', () => {
    const now = new Date(2026, 7, 11, 10, 30).getTime()
    const presets = Object.fromEntries(snoozePresets(now).map((preset) => [preset.id, preset.dueAt]))

    expect(presets['later-today']).toBe(new Date(2026, 7, 11, 13, 30).getTime())
    expect(presets.tonight).toBe(new Date(2026, 7, 11, 19).getTime())
    expect(presets.tomorrow).toBe(new Date(2026, 7, 12, 9).getTime())
    expect(presets.weekend).toBe(new Date(2026, 7, 15, 9).getTime())
    expect(presets['next-week']).toBe(new Date(2026, 7, 17, 9).getTime())
  })

  it('keeps fixed-time presets in the future', () => {
    const saturdayNight = new Date(2026, 7, 15, 20).getTime()
    const presets = Object.fromEntries(
      snoozePresets(saturdayNight).map((preset) => [preset.id, preset.dueAt])
    )

    expect(presets.tonight).toBe(new Date(2026, 7, 16, 19).getTime())
    expect(presets.weekend).toBe(new Date(2026, 7, 22, 9).getTime())
  })
})

it('resolves an omitted year to the next occurrence and displays that year', () => {
  const now = new Date(2026, 8, 11, 12).getTime()
  const due = parseSnoozeText('sep1', now)
  if (due === null) throw new Error('Expected a parsed date')
  expect(new Date(due).getFullYear()).toBe(2027)
  expect(formatSnoozeDate(due)).toContain('2027')
  expect(parseSnoozeText('September 1, 2026', now)).toBeLessThan(now)
})
