export interface ContactStats {
  email: string
  sentToCount: number
  receivedCount: number
  lastInteractedAt: number
  /** True when any stored display name for this contact starts with the query. */
  nameMatchesPrefix: boolean
}

export interface RankedContact {
  email: string
  score: number
}

export interface ContactSearchResult {
  name: string
  email: string
  score: number
}

const CONTACT_RECENCY_HALF_LIFE_MS = 90 * 24 * 60 * 60 * 1000
export const CONTACT_SEARCH_LIMIT = 8
/** Matches handed to rankContacts per recency/weight proxy — see searchContacts. */
export const CONTACT_CANDIDATE_LIMIT = 200

/** What an address falls back to when no correspondent ever supplied a display name. */
export function displayName(name: string | null | undefined, email: string): string {
  return name?.trim() || email.split('@')[0] || email
}

/**
 * Case-fold a name or address for search. Contacts are stored pre-folded through
 * this function and queries fold their needle through it too, so the two can never
 * disagree — and folding in JS rather than SQLite's ASCII-only lower() is what lets
 * "ürsula" match a contact stored as "Ürsula".
 *
 * Deliberately toLowerCase, not toLocaleLowerCase: the folded address is a primary
 * key, and Turkish casing maps 'I' to 'ı', so a locale-tailored fold would file
 * INFO@example.com under a key that a typed "info@example.com" never matches.
 * toLowerCase is Unicode-aware regardless, so "Ürsula" still folds correctly.
 */
export function foldForSearch(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * Order candidates the store has already matched against the query. Matching lives
 * in SQL so there is exactly one filter; this only scores and sorts, which keeps the
 * comparator pure and unit-testable. Prefix matches always precede infix matches;
 * interaction score breaks ties within each match class.
 */
export function rankContacts(
  contacts: readonly ContactStats[],
  query: string,
  selfEmail: string,
  now = Date.now(),
  limit = CONTACT_SEARCH_LIMIT
): RankedContact[] {
  const needle = foldForSearch(query)
  const self = foldForSearch(selfEmail)

  return contacts
    .filter((contact) => foldForSearch(contact.email) !== self)
    .map((contact) => {
      const email = foldForSearch(contact.email)
      const prefix = needle.length === 0 || contact.nameMatchesPrefix || email.startsWith(needle)
      const age = Math.max(0, now - contact.lastInteractedAt)
      const recencyMultiplier = 0.5 ** (age / CONTACT_RECENCY_HALF_LIFE_MS)
      const score = (3 * contact.sentToCount + contact.receivedCount) * recencyMultiplier
      return { contact, email, prefix, score }
    })
    .sort((left, right) => {
      if (left.prefix !== right.prefix) return left.prefix ? -1 : 1
      if (left.score !== right.score) return right.score - left.score
      if (left.contact.lastInteractedAt !== right.contact.lastInteractedAt) {
        return right.contact.lastInteractedAt - left.contact.lastInteractedAt
      }
      return left.email.localeCompare(right.email)
    })
    .slice(0, Math.max(0, limit))
    .map(({ email, score }) => ({ email, score }))
}
