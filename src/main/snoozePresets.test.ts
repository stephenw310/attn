import { describe, expect, it } from 'vitest'
import { snoozePresets } from '../shared/snooze'

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
