/** Narrow an unknown JSON value to a string array. */
export function stringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}
