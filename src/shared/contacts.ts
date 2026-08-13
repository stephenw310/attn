export interface ContactStats {
  name: string
  email: string
  sentToCount: number
  receivedCount: number
  lastInteractedAt: number
}

export interface ContactSearchResult {
  name: string
  email: string
  score: number
}

const RECENCY_HALF_LIFE_MS = 90 * 24 * 60 * 60 * 1000

/**
 * Rank local contacts without touching the store so the renderer can apply the
 * same ordering while the user types. Prefix matches always precede infix
 * matches; interaction score breaks ties within each match class.
 */
export function rankContacts(
  contacts: readonly ContactStats[],
  query: string,
  selfEmail: string,
  now = Date.now(),
  limit = 8
): ContactSearchResult[] {
  const needle = query.trim().toLocaleLowerCase()
  const self = selfEmail.trim().toLocaleLowerCase()

  return contacts
    .filter((contact) => contact.email.trim().toLocaleLowerCase() !== self)
    .map((contact) => {
      const email = contact.email.trim().toLocaleLowerCase()
      const name = contact.name.trim()
      const searchableName = name.toLocaleLowerCase()
      const prefix = needle.length === 0 || email.startsWith(needle) || searchableName.startsWith(needle)
      const infix = prefix || email.includes(needle) || searchableName.includes(needle)
      const age = Math.max(0, now - contact.lastInteractedAt)
      const recencyMultiplier = 0.5 ** (age / RECENCY_HALF_LIFE_MS)
      const score = (3 * contact.sentToCount + contact.receivedCount) * recencyMultiplier
      return { contact, email, name, prefix, infix, score }
    })
    .filter((candidate) => candidate.infix)
    .sort((left, right) => {
      if (left.prefix !== right.prefix) return left.prefix ? -1 : 1
      if (left.score !== right.score) return right.score - left.score
      if (left.contact.lastInteractedAt !== right.contact.lastInteractedAt) {
        return right.contact.lastInteractedAt - left.contact.lastInteractedAt
      }
      return left.email.localeCompare(right.email)
    })
    .slice(0, Math.max(0, limit))
    .map(({ email, name, score }) => ({
      name: name || email.split('@')[0] || email,
      email,
      score
    }))
}
