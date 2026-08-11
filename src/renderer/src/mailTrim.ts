const QUOTED_REPLY = /^On .{0,200} wrote:\s*$/gm
const TRAILING_QUOTES = /(?:^|\n)(?:> ?[^\n]*(?:\n|$))+$/
const MOBILE_SIGNATURE = /(?:^|\n)Sent from my (?:iPhone|iPad|Android|Galaxy[^\n]*)\s*$/im

export function findTrimIndex(text: string): number | null {
  const candidates: number[] = []
  const signature = text.indexOf('\n-- \n')
  if (signature >= 0) candidates.push(signature)

  for (const pattern of [QUOTED_REPLY, TRAILING_QUOTES, MOBILE_SIGNATURE]) {
    pattern.lastIndex = 0
    const match = pattern.exec(text)
    if (match) candidates.push(match.index)
  }

  const trimIndex = candidates.length > 0 ? Math.min(...candidates) : -1
  if (trimIndex < 0 || text.slice(0, trimIndex).trim().length === 0) return null
  return trimIndex
}
