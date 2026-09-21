import { isValidEmail, type MailAddress, normalizeEmailKey, parseAddressList } from './address'

/**
 * A `mailto:` URL arrives from the operating system, so it is untrusted input
 * of unbounded size. These limits live with the parser for that reason: they
 * bound what one link can put into a composer, and nothing downstream re-checks
 * them. Gmail's own header limit sets the subject cap.
 */
// Percent-encoding roughly triples a body, so the URL cap sits well above the
// body cap; a lower one would make the body cap unreachable rather than safer.
const MAX_URL_LENGTH = 256 * 1024
const MAX_RECIPIENTS_PER_FIELD = 100
const MAX_SUBJECT_LENGTH = 998
const MAX_BODY_LENGTH = 100_000

/** The header fields Attn honours (RFC 6068). Everything else is ignored. */
const HONOURED_HEADERS = ['to', 'cc', 'bcc', 'subject', 'body'] as const

type HonouredHeader = (typeof HONOURED_HEADERS)[number]

export interface MailtoPrefill {
  to: MailAddress[]
  cc: MailAddress[]
  bcc: MailAddress[]
  subject: string
  bodyText: string
}

/**
 * A compose request the main process is holding for whichever renderer tree is
 * ready to take it. Unlike a notification focus target it names no account: the
 * link says who to write to, never which mailbox writes.
 *
 * Pulling does not consume it. The tree that opens the composer acknowledges
 * `id`, so a pull whose delivery dies in a torn-down subscription cannot lose
 * the link — the same contract `PendingFocusTarget` uses.
 */
export interface PendingComposeTarget {
  id: number
  prefill: MailtoPrefill
}

/** Whether the OS registration is available, and whether Attn currently holds it. */
export interface DefaultMailClient {
  /** False in a development or test build, where the registration is a no-op. */
  supported: boolean
  isDefault: boolean
}

/** One sentence for the Settings row and the palette command to agree on. */
export function describeDefaultMailClient(state: DefaultMailClient): string {
  if (!state.supported) return 'Choosing a default email app is available in the installed Attn'
  return state.isDefault
    ? 'Attn is the default email app'
    : 'Your system settings still name another email app'
}

export function emptyMailtoPrefill(): MailtoPrefill {
  return { to: [], cc: [], bcc: [], subject: '', bodyText: '' }
}

function isHonouredHeader(name: string): name is HonouredHeader {
  return (HONOURED_HEADERS as readonly string[]).includes(name)
}

/** A malformed escape drops its own field rather than the whole link. */
function decodeField(value: string): string | null {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function recipients(parts: readonly string[]): MailAddress[] {
  const seen = new Set<string>()
  const addresses: MailAddress[] = []
  for (const part of parts) {
    for (const address of parseAddressList(part)) {
      if (!isValidEmail(address.email)) continue
      const key = normalizeEmailKey(address.email)
      if (seen.has(key)) continue
      seen.add(key)
      addresses.push(address)
      if (addresses.length === MAX_RECIPIENTS_PER_FIELD) return addresses
    }
  }
  return addresses
}

/** A subject is one header line: control characters cannot survive in it. */
function subjectText(value: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point.
  return value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, MAX_SUBJECT_LENGTH)
}

function bodyText(value: string): string {
  return (
    value
      .replace(/\r\n?/g, '\n')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: tabs and newlines are the only ones a body keeps.
      .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
      .slice(0, MAX_BODY_LENGTH)
  )
}

/**
 * Parse an OS-delivered `mailto:` URL into composer fields (RFC 6068). Returns
 * null for anything that is not a `mailto:` URL, including a scheme the OS
 * handed us by mistake; a bare `mailto:` is valid and opens an empty composer.
 *
 * The query is split by hand rather than through `URLSearchParams`, which
 * decodes `+` as a space. In a mailto URL `+` is a literal character, and
 * address tags (`user+tag@example.com`) are the everyday case that breaks.
 *
 * `attach`/`attachment` and every other header are ignored by design: a link
 * from a web page must never name a file for Attn to read.
 */
export function parseMailtoUrl(raw: string): MailtoPrefill | null {
  if (typeof raw !== 'string' || raw.length > MAX_URL_LENGTH) return null
  const trimmed = raw.trim()
  if (!/^mailto:/i.test(trimmed)) return null

  // RFC 6068 has no fragment, but a browser hands the handler the whole string
  // it found in the href, trailing `#…` included.
  const rest = trimmed.slice('mailto:'.length).replace(/#.*$/s, '')
  const queryAt = rest.indexOf('?')
  const fields = new Map<HonouredHeader, string[]>()
  const head = decodeField(queryAt < 0 ? rest : rest.slice(0, queryAt))
  if (head) fields.set('to', [head])

  for (const pair of (queryAt < 0 ? '' : rest.slice(queryAt + 1)).split('&')) {
    if (!pair) continue
    const separator = pair.indexOf('=')
    if (separator < 0) continue
    const name = decodeField(pair.slice(0, separator))?.trim().toLowerCase()
    const value = decodeField(pair.slice(separator + 1))
    if (name === undefined || value === null || !isHonouredHeader(name)) continue
    const existing = fields.get(name)
    // Recipients accumulate across repeats; a repeated subject or body is a
    // malformed link, and the first one wins rather than the last.
    if (!existing) fields.set(name, [value])
    else if (name === 'to' || name === 'cc' || name === 'bcc') existing.push(value)
  }

  return {
    to: recipients(fields.get('to') ?? []),
    cc: recipients(fields.get('cc') ?? []),
    bcc: recipients(fields.get('bcc') ?? []),
    subject: subjectText(fields.get('subject')?.[0] ?? ''),
    bodyText: bodyText(fields.get('body')?.[0] ?? '')
  }
}
