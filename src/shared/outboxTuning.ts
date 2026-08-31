// Compile-time composer and outbox defaults shared by main and renderer.
// No runtime dependencies. MIME rules and attachment safety limits stay with
// their validators; these values control saving, sending, and retention.

/** Local saves run after idle typing or at the checkpoint deadline while dirty. */
export const IDLE_SAVE_MS = 1_000
export const MAX_CHECKPOINT_MS = 5_000
export const MIRROR_IDLE_MS = 3_000

/**
 * Gmail replaces a draft wholesale, re-uploading all attachments. Body edits
 * above this payload threshold wait longer between pushes. Attachment changes
 * still use MIRROR_IDLE_MS so Gmail reflects them sooner.
 */
export const MIRROR_PAYLOAD_IDLE_MS = 15_000
export const MIRROR_PAYLOAD_BYTES = 1_000_000

/** The persisted undoSendDelaySeconds preference overrides the default. */
export const DEFAULT_UNDO_SEND_SECONDS = 5
export const ALLOWED_UNDO_SEND_SECONDS: ReadonlySet<number> = new Set([0, 5, 8, 10, 20, 30])

/** Successful negative searches allowed before an ambiguous send needs review. */
export const SECONDARY_CHECK_MS = 10_000
export const SECONDARY_CHECKS = 6
/** Candidates per RFC Message-ID lookup, independent of Gmail's normal page sizes. */
export const RFC_MESSAGE_LOOKUP_LIMIT = 10

/** About 6.5 minutes on the shared mail retry ladder before an attachment source fails. */
export const MAX_ATTACHMENT_SOURCE_ATTEMPTS = 8
export const OUTBOX_OFFLINE_RECHECK_MS = 30_000

/** Independent deadlines for persisting the sender's and mirror's in-flight results. */
export const OUTBOX_STOP_TIMEOUT_MS = 5_000
export const MIRROR_STOP_TIMEOUT_MS = 5_000

/** Retain settled outbox records; this does not delete mail from Sent. */
export const SENT_OUTBOX_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000
