// The backfill's tunable time windows, in one place so a load-time experiment
// is a one-line change. Values are Gmail search operators (`newer_than:` takes
// d/m/y units only, with coarse day-level boundaries — which is why stages
// overlap and dedupe instead of carving complements, see backfill.ts).
//
// Tuning notes:
// - Time-to-interactive is bound by the *inbox size* inside INBOX_METADATA_WINDOW,
//   not the window length; shrinking it mostly changes how much inbox history is
//   visible, because threads reached only by the lifetime sweep are stored
//   inbox-invisible (`is_inbox_visible`). Shrink with that product effect in mind.
// - INBOX_BODIES_WINDOW is the dominant backfill-duration knob: full-format
//   fetches plus body-part hydration are the expensive calls. Bodies outside the
//   window still load on open (on-demand hydration) and are cached permanently.
// - ALL_MAIL_WINDOW bounds the normal-priority archive/sent tier; everything
//   older arrives via the throttled lifetime sweep (pacing knobs live as the
//   LIFETIME_* constants in lifetimeSweep.ts).

/** Stage 1: Inbox metadata — the triage surface and its unread count. */
export const INBOX_METADATA_WINDOW = 'newer_than:12m'

/** Stage 2: eager full Inbox bodies for offline reading. */
export const INBOX_BODIES_WINDOW = 'newer_than:90d'

/** Stage 4: unfiltered metadata — archived + sent + everything outside Spam/Trash. */
export const ALL_MAIL_WINDOW = 'newer_than:12m'
