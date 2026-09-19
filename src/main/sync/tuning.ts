// Compile-time defaults for mail storage, reads, sync scheduling, and Gmail
// throughput. Keep this module free of runtime dependencies. Existing injected
// options and the OAuth project's quota override still take precedence.
//
// Composer and outbox policy lives in `shared/outboxTuning.ts`; renderer timing
// lives in `renderer/src/tuning.ts`. Protocol contracts stay with their owners:
// Gmail's per-method quota costs in `gmail/quota.ts`, and renderer paging in
// `shared/mail.ts`. Equal values do not imply that two policies should be linked.

// The lifetime-cap default and the All-mail sentinel are declared in
// `shared/settings.ts` so the settings surface labels the same numbers the
// sweep enforces; this module remains their documented home for sync policy.
import { DEFAULT_LIFETIME_THREAD_CAP, LIFETIME_THREAD_CAP_ALL_MAIL } from '../../shared/settings'

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
 * SPEC F2 bounds historical header fetching with this limit. At about 2.5
 * messages per thread, 400,000 threads holds roughly one million messages.
 *
 * The cost it bounds is time, not just disk. Gmail admits background work at
 * 6,000 quota units a minute, less a 500-unit interactive reserve, and a thread
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
export const LIFETIME_THREAD_CAP = DEFAULT_LIFETIME_THREAD_CAP

/** No cap: store the entire account, whatever it costs. */
export const LIFETIME_THREAD_CAP_UNLIMITED = LIFETIME_THREAD_CAP_ALL_MAIL

// ---------------------------------------------------------------------------
// Gmail requests and quota policy
// ---------------------------------------------------------------------------

/** Request page sizes, not total sync or search limits. */
export const GMAIL_THREAD_PAGE_SIZE = 100
export const GMAIL_DRAFT_PAGE_SIZE = 100
export const GMAIL_HISTORY_PAGE_SIZE = 500

/** Fallback when the OAuth configuration does not specify the project's quota. */
export const DEFAULT_GMAIL_QUOTA_UNITS_PER_MINUTE = 6_000
export const GMAIL_QUOTA_BURST_SECONDS = 6

/** Cumulative floors: each priority leaves these units available to higher priorities. */
export const GMAIL_QUOTA_RESERVED_UNITS = {
  send: 0,
  action: 200,
  polling: 300,
  foreground: 400,
  background: 500
} as const

/** Refresh an access token before its expiry to allow time for the next request. */
export const GMAIL_TOKEN_REFRESH_MARGIN_MS = 60_000

/** A 401 refresh consumes the same attempt budget as transient retries. */
export const GMAIL_MAX_RETRIES = 7
/** The exponent starts at one, so the first transient retry waits twice this base. */
export const GMAIL_RETRY_BASE_MS = 1_000
export const GMAIL_RETRY_MAX_MS = 65_000
export const GMAIL_RETRY_JITTER_MS = 1_000

// ---------------------------------------------------------------------------
// Foreground sync and retries
// ---------------------------------------------------------------------------

export const FOREGROUND_POLL_MS = 15_000
export const BACKGROUND_POLL_MS = 60_000
export const OFFLINE_SYNC_RETRY_MS = 15_000
export const LIFETIME_RETRY_MS = 15_000
export const FTS_RETRY_MS = 15_000

/** Independent concurrency limits for thread and draft bootstrap fetches. */
export const BACKFILL_THREAD_CONCURRENCY = 3
export const BACKFILL_DRAFT_CONCURRENCY = 3

/** Retry ladder shared by queued mail actions, draft mirrors, and the outbox sender. */
export const MAIL_RETRY_FIRST_MS = 5_000
export const MAIL_RETRY_SECOND_MS = 30_000
export const MAIL_RETRY_MAX_MS = 60_000

/** Bound a body fetch and the retained unavailable states for opened conversations. */
export const BODY_HYDRATION_TIMEOUT_MS = 30_000
export const MAX_RETAINED_BODY_HYDRATION_STATES = 256

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

/** Internal diagnostic reads; renderer mailbox reads use THREAD_PAGE_SIZE plus lookahead. */
export const THREAD_LIST_LIMIT = 10_000

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

// ---------------------------------------------------------------------------
// Split triage
// ---------------------------------------------------------------------------

/**
 * The yes-probability a stored judgment needs before a described split claims
 * the thread. Measured with `scripts/triage-eval.mjs` on 2026-09-18 over 100
 * Inbox threads and four described splits: true positives scored 0.72 or
 * above and true negatives 0.53 or below, so 0.6 and 0.7 claim the same
 * threads. Three splits reached precision and recall 1.00; the fourth's two
 * misses scored above 0.78, which a threshold cannot fix — a tighter
 * description can. Re-run the eval before changing this.
 */
export const SPLIT_TRIAGE_THRESHOLD = 0.7

/**
 * How much of one message the judgment state carries. The model reads state
 * literally and unrelated detail costs accuracy, so this is a deliberate cut
 * rather than the largest excerpt the request limit would allow.
 */
export const SPLIT_TRIAGE_EXCERPT_CHARS = 1_500

/** One pack's judgment request, aborted at this deadline. */
export const SPLIT_TRIAGE_REQUEST_TIMEOUT_MS = 10_000

/**
 * Conversations carried by one request. Measured on 2026-09-18 against 95
 * labeled Inbox conversations, four AI rules and `jev-latest`, comparing packed
 * answers with single-conversation answers at threshold 0.7.
 *
 * At ten per request the mean absolute change was 0.03 to 0.06. Three rules
 * flipped nothing; the fourth dropped one false positive, so its precision rose
 * from 0.82 to 0.90. The change by slot ran from 0.016 at slot 0 to 0.071 at
 * slots 1 to 9. All 95 conversations were judged in ten requests in 0.9 s.
 *
 * At twenty-five per request the mean absolute change was 0.16 to 0.24, 26
 * answers flipped, precision fell to 0.70 to 0.87, and slots 12 to 23 drifted
 * 0.19 to 0.36. Pack ten, never more.
 *
 * The cap counts conversations, not questions: the measurement ran four rules,
 * so ten conversations were forty questions in one request.
 */
export const SPLIT_TRIAGE_PACK_SIZE = 10

/** Threads selected per batch (four packs), and requests in flight inside one batch. */
export const SPLIT_TRIAGE_BATCH_SIZE = 40
export const SPLIT_TRIAGE_CONCURRENCY = 4

/**
 * Floor between split-revision bumps while a pass runs. Each broadcast makes
 * the renderer refetch the list and every split count, so on an 11k-thread
 * Inbox a one-second cadence starved multi-page reads: they abort when the
 * split revision changes mid-read. Fifteen seconds keeps the app usable while a
 * pass runs, and the pass still broadcasts once when it ends.
 */
export const SPLIT_TRIAGE_BROADCAST_INTERVAL_MS = 15_000

/**
 * A pack's retry ladder for 429 and 529, and the Retry-After cap. Six attempts
 * walk 1, 2, 4, 8, 16 and 32 seconds, so a busy minute is waited out inside the
 * request rather than charged to the conversations it carried.
 */
export const SPLIT_TRIAGE_RATE_LIMIT_BASE_MS = 1_000
export const SPLIT_TRIAGE_RATE_LIMIT_MAX_ATTEMPTS = 6
export const SPLIT_TRIAGE_RATE_LIMIT_MAX_WAIT_MS = 60_000

/**
 * A conversation's own retry ladder after a rejected or exhausted request, and
 * how many attempts it gets. The record survives the pass, so a dropped pack
 * comes back by itself instead of waiting for the next mail change. Past the
 * last attempt the conversation is reported as unjudged rather than counted as
 * pending forever.
 */
export const SPLIT_TRIAGE_FAILURE_BACKOFF_MS = [60_000, 300_000, 1_800_000]
export const SPLIT_TRIAGE_MAX_ATTEMPTS = 3

/** A pass paused by a network failure resumes after this delay. */
export const SPLIT_TRIAGE_OFFLINE_RETRY_MS = 60_000

/**
 * How long an arriving message waits for its judgment before the notification
 * decision goes ahead without it. Short on purpose: a notification that lands
 * a minute late is worse than one routed by the previous assignment.
 */
export const SPLIT_TRIAGE_NOTIFY_WAIT_MS = 2_000

/**
 * A judgment that lands after that wait may still notify, while the message is
 * recent enough for a notification to make sense. Past this age the arrival is
 * history, so a late judgment changes the Inbox and stays silent.
 */
export const SPLIT_TRIAGE_LATE_NOTIFY_WINDOW_MS = 10 * 60_000

/** Message ids the runtime remembers to keep a late judgment from notifying twice. */
export const SPLIT_TRIAGE_NOTIFIED_MESSAGE_MEMORY = 500
