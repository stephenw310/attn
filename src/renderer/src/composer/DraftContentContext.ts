import { createContext } from 'react'

export const DraftContentIdContext = createContext<string | null>(null)

/**
 * The draft's source message (the one being replied to or forwarded), so
 * preserved opaque regions can register their preview frames with main's
 * remote-image filter under that message — the same identity the quoted
 * history uses (T33, PR #101 review). Null for a draft with no source
 * message; its frames then stay unnamed and fail closed while blocking is on.
 */
export const DraftSourceMessageIdContext = createContext<string | null>(null)
