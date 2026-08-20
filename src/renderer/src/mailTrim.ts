const QUOTED_REPLY = /^On .{0,200} wrote:\s*$/gm
const MOBILE_SIGNATURE = /(?:^|\n)Sent from my (?:iPhone|iPad|Android|Galaxy[^\n]*)\s*$/im
const RFC_SIGNATURE = /(?:^|\n)--[ \t]*(?=\n|$)/m
const DECORATED_TEAM_SIGNATURE =
  /(?:^|\n)[ \t]*--[ \t]+[^\n]{0,116}\b(?:team|staff|support|customer (?:care|service))\b[^\n]{0,116}?[ \t]+--[ \t]*(?=\n|$)/im

function matchIndex(text: string, pattern: RegExp): number | null {
  pattern.lastIndex = 0
  return pattern.exec(text)?.index ?? null
}

/** Find a conventional signature line, including `-- The Example Team --`. */
export function findSignatureLineIndex(text: string): number | null {
  const matches = [RFC_SIGNATURE, DECORATED_TEAM_SIGNATURE, MOBILE_SIGNATURE]
    .map((pattern) => matchIndex(text, pattern))
    .filter((index): index is number => index !== null)
  return matches.length > 0 ? Math.min(...matches) : null
}

function trailingQuoteIndex(text: string): number | null {
  let lineEnd = text.endsWith('\n') && !text.endsWith('\n\n') ? text.length - 1 : text.length
  let quoteStart = -1

  while (lineEnd > 0) {
    const newline = text.lastIndexOf('\n', lineEnd - 1)
    const lineStart = newline + 1
    if (!text.startsWith('>', lineStart)) break
    quoteStart = lineStart
    lineEnd = newline
  }

  if (quoteStart < 0) return null
  return quoteStart > 0 && text[quoteStart - 1] === '\n' ? quoteStart - 1 : quoteStart
}

export function findTrimIndex(text: string): number | null {
  const candidates: number[] = []
  const signature = findSignatureLineIndex(text)
  if (signature !== null) candidates.push(signature)

  const trailingQuote = trailingQuoteIndex(text)
  if (trailingQuote !== null) candidates.push(trailingQuote)

  for (const pattern of [QUOTED_REPLY]) {
    pattern.lastIndex = 0
    const match = pattern.exec(text)
    if (match) candidates.push(match.index)
  }

  const trimIndex = candidates.length > 0 ? Math.min(...candidates) : -1
  if (trimIndex < 0 || text.slice(0, trimIndex).trim().length === 0) return null
  return trimIndex
}
