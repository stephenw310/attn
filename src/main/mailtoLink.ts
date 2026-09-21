import type { MailtoPrefill, PendingComposeTarget } from '../shared/mailto'

/**
 * How long a compose request stays honourable. A cold start has to boot the
 * utility process, open SQLite, and mount a renderer before any tree can pull,
 * so this window is deliberately wide — wider than a click-to-focus target
 * needs. Past it the link is stale: the window is up, and opening a composer
 * the user no longer expects would be worse than doing nothing.
 */
export const PENDING_COMPOSE_TTL_MS = 60_000

export interface PendingCompose {
  prefill: MailtoPrefill
  at: number
}

/**
 * Resolve the compose request a renderer may take. Resolving is read-only, as
 * `takePendingFocus` is: the tree that actually opened the composer clears the
 * request by acknowledging its id, so a pull whose delivery dies in a torn-down
 * subscription cannot silently swallow the link. Only an expired or absent
 * request answers null.
 */
export function takePendingCompose(
  pending: PendingCompose | null,
  now = Date.now()
): PendingComposeTarget | null {
  if (!pending || now - pending.at > PENDING_COMPOSE_TTL_MS) return null
  return { id: pending.at, prefill: pending.prefill }
}

/** Keyed by the request's creation time, so a late acknowledgement cannot clear a newer link. */
export function acknowledgePendingCompose(pending: PendingCompose | null, id: number): PendingCompose | null {
  if (pending && pending.at === id) return null
  return pending
}

/**
 * The `mailto:` URL a launch carried. Windows and Linux deliver deep links as
 * a command-line argument rather than through `open-url`, both for a cold start
 * and for the second instance the single-instance lock turns away.
 */
export function mailtoUrlFromArgv(argv: readonly string[]): string | null {
  return argv.find((argument) => typeof argument === 'string' && /^mailto:/i.test(argument)) ?? null
}
