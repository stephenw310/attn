import { GmailApiError } from '../gmail/client'

const PAGE_TOKEN_PATTERN = /page[\s_-]*token/i

/**
 * Gmail uses 400 and 404 for invalid saved cursors, but both statuses also
 * cover unrelated request failures. Restart a durable walk only when Gmail's
 * diagnostic identifies the page token as the bad input.
 */
export function isExpiredPageTokenError(error: unknown): boolean {
  return (
    error instanceof GmailApiError &&
    (error.status === 400 || error.status === 404) &&
    PAGE_TOKEN_PATTERN.test(error.message)
  )
}
