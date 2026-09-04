interface CommandUsageEntry {
  count: number
  lastUsedAt: number
}

export type CommandUsage = Record<string, CommandUsageEntry>

export const COMMAND_USAGE_LIMIT = 100

function validEntry(value: unknown): value is CommandUsageEntry {
  if (!value || typeof value !== 'object') return false
  const entry = value as Partial<CommandUsageEntry>
  return (
    Number.isSafeInteger(entry.count) &&
    (entry.count ?? 0) > 0 &&
    Number.isSafeInteger(entry.lastUsedAt) &&
    (entry.lastUsedAt ?? 0) > 0
  )
}

/** Accept only bounded command ids and finite usage counters from IPC or storage. */
export function sanitizeCommandUsage(value: unknown): CommandUsage {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(
    Object.entries(value)
      .filter(([id, entry]) => id.length > 0 && id.length <= 100 && !/^[=+@]/.test(id) && validEntry(entry))
      .sort((left, right) => right[1].lastUsedAt - left[1].lastUsedAt)
      .slice(0, COMMAND_USAGE_LIMIT)
  )
}

export function parseStoredCommandUsage(value: string | undefined): CommandUsage {
  if (!value) return {}
  try {
    return sanitizeCommandUsage(JSON.parse(value))
  } catch {
    return {}
  }
}
