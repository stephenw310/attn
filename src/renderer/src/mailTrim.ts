const QUOTED_REPLY = /^On .{0,200} wrote:\s*$/gm
const MOBILE_SIGNATURE = /(?:^|\n)Sent from my (?:iPhone|iPad|Android|Galaxy[^\n]*)\s*$/im

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
  const signature = text.indexOf('\n-- \n')
  if (signature >= 0) candidates.push(signature)

  const trailingQuote = trailingQuoteIndex(text)
  if (trailingQuote !== null) candidates.push(trailingQuote)

  for (const pattern of [QUOTED_REPLY, MOBILE_SIGNATURE]) {
    pattern.lastIndex = 0
    const match = pattern.exec(text)
    if (match) candidates.push(match.index)
  }

  const trimIndex = candidates.length > 0 ? Math.min(...candidates) : -1
  if (trimIndex < 0 || text.slice(0, trimIndex).trim().length === 0) return null
  return trimIndex
}
