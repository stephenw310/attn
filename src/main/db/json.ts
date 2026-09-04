/**
 * One contract for reading a JSON column back out of SQLite (review R13): a
 * missing column yields the caller's fallback, and malformed stored text throws
 * rather than being quietly read as empty. Every writer of these columns is our
 * own `JSON.stringify`, so unparseable text means a corrupted store, not user
 * input to tolerate.
 */
export function parseJson<T>(value: string | null, fallback: T): T {
  return value === null ? fallback : (JSON.parse(value) as T)
}
