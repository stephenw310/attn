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
