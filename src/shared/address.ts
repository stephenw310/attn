export interface MailAddress {
  name: string
  email: string
}

export function parseAddress(raw: string): MailAddress {
  const match = raw.match(/^\s*"?([^"<]*)"?\s*<([^>]+)>\s*$/)
  if (match) {
    const name = match[1].trim()
    const email = match[2].trim()
    return { name: name || email.split('@')[0], email }
  }
  const email = raw.trim()
  return { name: email.split('@')[0] || email, email }
}

/** Split an RFC-style address list without breaking quoted display names. */
export function parseAddressList(raw: string): MailAddress[] {
  const parts: string[] = []
  let start = 0
  let quoted = false
  let escaped = false
  let angleDepth = 0

  for (let index = 0; index < raw.length; index++) {
    const char = raw[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (char === '\\' && quoted) {
      escaped = true
      continue
    }
    if (char === '"') {
      quoted = !quoted
      continue
    }
    if (!quoted && char === '<') angleDepth++
    else if (!quoted && char === '>') angleDepth = Math.max(0, angleDepth - 1)
    else if (!quoted && angleDepth === 0 && char === ',') {
      parts.push(raw.slice(start, index))
      start = index + 1
    }
  }
  parts.push(raw.slice(start))

  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map(parseAddress)
    .filter((address) => address.email.length > 0)
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(value.trim())
}

export interface RecipientParseResult {
  recipients: MailAddress[]
  invalid: string[]
}

/** Parse chips in one pass so an invalid token can be shown instead of silently dropped. */
export function parseRecipientInput(raw: string): RecipientParseResult {
  const recipients = parseAddressList(raw)
  const invalid = recipients
    .filter((recipient) => !isValidEmail(recipient.email))
    .map((recipient) => recipient.email)
  return {
    recipients: recipients.filter((recipient) => isValidEmail(recipient.email)),
    invalid
  }
}
