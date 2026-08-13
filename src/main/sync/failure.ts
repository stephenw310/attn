import type { SyncState } from '../../shared/mail'

const OFFLINE_ERROR_CODES = new Set([
  'EAI_AGAIN',
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'ENETDOWN',
  'ENETUNREACH',
  'ENOTFOUND',
  'ETIMEDOUT'
])

const OFFLINE_MESSAGE =
  /\b(fetch failed|network request failed|network is unreachable|no internet|offline)\b/i

interface ErrorLike {
  cause?: unknown
  code?: unknown
  message?: unknown
}

export function syncFailureState(error: unknown): Extract<SyncState, { phase: 'offline' | 'error' }> {
  const message = errorMessage(error)
  return isOfflineFailure(error) ? { phase: 'offline', message } : { phase: 'error', message }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function isOfflineFailure(error: unknown): boolean {
  const seen = new Set<unknown>()
  let current: unknown = error
  while (current && !seen.has(current)) {
    seen.add(current)
    if (typeof current === 'object') {
      const candidate = current as ErrorLike
      if (typeof candidate.code === 'string' && OFFLINE_ERROR_CODES.has(candidate.code)) return true
      if (typeof candidate.message === 'string' && OFFLINE_MESSAGE.test(candidate.message)) return true
      current = candidate.cause
      continue
    }
    if (typeof current === 'string' && OFFLINE_MESSAGE.test(current)) return true
    break
  }
  return false
}
