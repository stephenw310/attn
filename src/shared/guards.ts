/** Narrow an unknown JSON value to a string array. */
export function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

/** Narrow an unknown IPC argument to a non-empty string. */
export function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}
