// Compile-time renderer interaction timings. Composer persistence policy lives
// in `shared/outboxTuning.ts`; layout measurements stay with their components.

export const SEARCH_DEBOUNCE_MS = 25
export const CONTACT_AUTOCOMPLETE_DEBOUNCE_MS = 80
export const CHORD_TIMEOUT_MS = 3_000
/** Send countdowns override this with their persisted deadline. */
export const DEFAULT_TOAST_DURATION_MS = 4_000
export const INBOX_ZERO_CLOCK_INTERVAL_MS = 30_000
/**
 * How long a clicked Settings heading keeps the contents mark while the page
 * scrolls to it. The last sections share one screenful, so geometry alone
 * would mark whichever sits last however the reader arrived.
 */
export const SETTINGS_HEADING_PIN_MS = 700
/**
 * The gap a Settings heading keeps above the scroller when the contents column
 * scrolls to it, and the line the same column measures against to decide which
 * heading the reader is on. One number, so the two cannot drift: the heading takes it as an
 * inline `scroll-margin-top` and the contents column reads the same constant.
 */
export const SETTINGS_HEADING_OFFSET_PX = 24
