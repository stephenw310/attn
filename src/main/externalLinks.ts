// The last gate before a link in mail reaches the OS (SPEC §6 Security).
//
// DOMPurify's default URI policy admits `tel:`, `sms:`, `callto:`, `xmpp:`
// and friends, and the mail frames carry `allow-popups`, so a click inside a
// newsletter arrives at the window-open handler as an arbitrary scheme.
// Handing that to `shell.openExternal` launches whatever protocol handler the
// OS has registered for it, so main — which never trusts the renderer —
// allows only the three schemes a mail link is meant to hand off.

const OPENABLE_SCHEMES: ReadonlySet<string> = new Set(['http:', 'https:', 'mailto:'])

export function isOpenableExternalUrl(url: string): boolean {
  try {
    return OPENABLE_SCHEMES.has(new URL(url).protocol)
  } catch {
    // Not a parseable absolute URL — nothing the OS should be asked to open.
    return false
  }
}
