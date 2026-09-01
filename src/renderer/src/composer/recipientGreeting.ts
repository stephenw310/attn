import type { MailAddress } from '../../../shared/address'

/** A short, human greeting name from an actual display name, never an email local-part guess. */
export function recipientGreetingName(recipient: MailAddress | undefined): string | null {
  const display = recipient?.name.trim() ?? ''
  if (!display || display.toLowerCase() === recipient?.email.trim().toLowerCase()) return null

  // Address books commonly store "Family, Given". Prefer the given-name side
  // for a greeting, then use its first word just as the reader summary does.
  const ordered = display.includes(',') ? display.split(',').slice(1).join(',').trim() || display : display
  const token = ordered.split(/\s+/, 1)[0]?.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}'’-]+$/gu, '')
  return token && !token.includes('@') ? token : null
}

/**
 * Complete only a greeting at the very start of an otherwise empty authored
 * body. The result is local and deterministic; no AI setting or provider is
 * involved. Partial name typing is supported so "Hi Th" continues as "eo,".
 */
export function recipientGreetingSuggestion(
  prefix: string,
  suffix: string,
  recipientName: string | null
): string | null {
  if (!recipientName || suffix.trim().length > 0 || prefix.includes('\n')) return null
  const match = /^(?:hi|hello|hey)(\s*)([^\s,]*)$/iu.exec(prefix)
  if (!match) return null
  const space = match[1] ?? ''
  const typedName = match[2] ?? ''
  if (!recipientName.toLowerCase().startsWith(typedName.toLowerCase())) return null
  return `${space.length === 0 ? ' ' : ''}${recipientName.slice(typedName.length)},`
}
