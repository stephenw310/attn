import * as chrono from 'chrono-node'

export type SnoozePresetId = 'later-today' | 'tonight' | 'tomorrow' | 'weekend' | 'next-week'

export interface SnoozePreset {
  id: SnoozePresetId
  label: string
  dueAt: number
}

function atLocalTime(base: Date, daysAhead: number, hour: number): number {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate() + daysAhead, hour, 0, 0, 0).getTime()
}

export function snoozePresets(nowMs = Date.now()): SnoozePreset[] {
  const now = new Date(nowMs)
  let saturdayAhead = (6 - now.getDay() + 7) % 7
  if (saturdayAhead === 0 && atLocalTime(now, 0, 9) <= nowMs) saturdayAhead = 7
  let mondayAhead = (1 - now.getDay() + 7) % 7
  if (mondayAhead === 0) mondayAhead = 7
  const tonight = atLocalTime(now, 0, 19)

  return [
    { id: 'later-today', label: 'Later today', dueAt: nowMs + 3 * 60 * 60 * 1000 },
    {
      id: 'tonight',
      label: 'Tonight',
      dueAt: tonight > nowMs ? tonight : atLocalTime(now, 1, 19)
    },
    { id: 'tomorrow', label: 'Tomorrow', dueAt: atLocalTime(now, 1, 9) },
    { id: 'weekend', label: 'This weekend', dueAt: atLocalTime(now, saturdayAhead, 9) },
    { id: 'next-week', label: 'Next week', dueAt: atLocalTime(now, mondayAhead, 9) }
  ]
}

export function parseSnoozeText(text: string, nowMs = Date.now()): number | null {
  const parsed = chrono.parseDate(text, new Date(nowMs), { forwardDate: true })
  return parsed?.getTime() ?? null
}

export function formatSnoozeDate(dueAt: number): string {
  return new Date(dueAt).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}
