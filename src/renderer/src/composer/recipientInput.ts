import { parseRecipientInput } from '../../../shared/address'

/**
 * A comma separates recipients everywhere except inside a quoted display name:
 * `"Doe, John" <j@x>` is one address, and committing at the comma leaves the
 * user unable to type it at all (review B30). Only an *open* quote suppresses
 * the commit, so `"Doe, John" <j@x>, ` still separates.
 */
export function shouldCommitOnComma(value: string, caret: number): boolean {
  let quoted = false
  for (let index = 0; index < Math.min(caret, value.length); index += 1) {
    const character = value[index]
    if (character === '\\' && quoted) index += 1
    else if (character === '"') quoted = !quoted
  }
  return !quoted
}

/** Typed text that already is one complete address needs no suggestion. */
export function isCompleteRecipient(value: string): boolean {
  if (!value.trim()) return false
  const parsed = parseRecipientInput(value)
  return parsed.invalid.length === 0 && parsed.recipients.length > 0
}
