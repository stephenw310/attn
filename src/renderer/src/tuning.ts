// Compile-time renderer interaction timings. Composer persistence policy lives
// in `shared/outboxTuning.ts`; layout measurements stay with their components.

export const SEARCH_DEBOUNCE_MS = 25
export const CONTACT_AUTOCOMPLETE_DEBOUNCE_MS = 80
export const CHORD_TIMEOUT_MS = 3_000
/** Send countdowns override this with their persisted deadline. */
export const DEFAULT_TOAST_DURATION_MS = 4_000
export const TOAST_COUNTDOWN_TICK_MS = 250
export const INBOX_ZERO_CLOCK_INTERVAL_MS = 30_000

export const TOOLTIP_DELAY_MS = 120

/** Reshow AI draft discovery after the user pauses editing. */
export const AI_DRAFT_HINT_IDLE_MS = 1_200
