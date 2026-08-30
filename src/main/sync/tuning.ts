// Every knob that decides how much mail Attn stores and how hard it works to
// store it, in one file so a load-time experiment is a one-line change.
//
// This file replaces the narrower `windows.ts`: the date windows were never the
// only tunables, and having the pacing constants scattered across the modules
// that use them meant reasoning about sync cost required opening six files.
// Values that describe a *contract* rather than a preference stay where they are
// enforced: Gmail's quota unit table lives in `gmail/quota.ts` because it is
// Google's table, not ours, and `THREAD_PAGE_SIZE` lives in `shared/mail.ts`
// because the renderer pages against it.

// ---------------------------------------------------------------------------
// How much mail is stored
// ---------------------------------------------------------------------------

/** Stage 1: Inbox metadata — the triage surface and its unread count. */
export const INBOX_METADATA_WINDOW = 'newer_than:12m'

/** Stage 2: eager full Inbox bodies for offline reading. */
export const INBOX_BODIES_WINDOW = 'newer_than:90d'

/** Stage 4: unfiltered metadata — archived + sent + everything outside Spam/Trash. */
export const ALL_MAIL_WINDOW = 'newer_than:12m'

/**
 * How many conversations the lifetime sweep keeps locally, newest first.
 *
 * SPEC §9 #22 targets smooth operation to roughly a million messages, and this
 * is what makes that target real rather than aspirational. At about 2.5 messages
 * per thread, 400,000 threads is that million.
 *
 * The cost it bounds is time, not just disk. Gmail admits background work at
 * 6,000 quota units a minute, less a 400-unit interactive reserve, and a thread
 * fetch costs 40: about 137 threads a minute. 400,000 threads is therefore
 * roughly 48 hours of app-open time, so an account several times larger spends
 * months indexing and tens of gigabytes doing it.
 *
 * Mail past the cap is not lost to the user: `search.allGmail` queries the
 * server, and the search field advertises it on every local result.
 *
 * Raising this resumes the sweep from its cursor, because the walk is newest
 * first and idempotent. Lowering it stops further fetching and deliberately
 * deletes nothing — a setting that silently discarded stored mail would be a
 * worse surprise than a store slightly larger than the current preference.
 */
export const LIFETIME_THREAD_CAP = 400_000

/** No cap: store the entire account, whatever it costs. */
export const LIFETIME_THREAD_CAP_UNLIMITED = 0

// ---------------------------------------------------------------------------
// How hard the background passes work
// ---------------------------------------------------------------------------

/** Minimum spacing between the lifetime sweep's Gmail requests. */
export const LIFETIME_REQUEST_INTERVAL_MS = 100

/** Pause after each listing page, so a sweep never monopolises the quota. */
export const LIFETIME_PAGE_PAUSE_MS = 1_000

/** How long any background pass waits while foreground work holds the provider. */
export const LIFETIME_FOREGROUND_YIELD_MS = 250

/** Local FTS backfill: rows per committed batch, and the gap between batches. */
export const FTS_BACKFILL_BATCH_SIZE = 200
export const FTS_BACKFILL_BATCH_PAUSE_MS = 25

/**
 * Derived mailbox membership backfill. Larger batches than FTS because the pass
 * is set-based SQL rather than per-row work, and it runs before any Gmail work
 * on an upgraded profile, where finishing quickly matters more.
 */
export const MAILBOX_BACKFILL_BATCH_SIZE = 2_000
export const MAILBOX_BACKFILL_BATCH_PAUSE_MS = 10

// ---------------------------------------------------------------------------
// How much a read is allowed to look at
// ---------------------------------------------------------------------------

/** Rows a local search returns. */
export const SEARCH_RESULT_LIMIT = 100

/**
 * Matching messages a text search considers, newest first, before filters and
 * projection run. A word common enough to appear in most mail otherwise matches
 * every message in the account, and the outer query orders by recency rather
 * than rank, so its row limit cannot push into the index scan. Matches beyond
 * this window mark the response partial.
 */
export const SEARCH_RECENT_MESSAGE_LIMIT = 2_000
