import type { SyncStage } from '../../shared/mail'

function defineBackfillPhases<const T extends readonly SyncStage[]>(
  phases: T & (Exclude<SyncStage, T[number]> extends never ? unknown : readonly ['Missing SyncStage'])
): T {
  return phases
}

/** Backfill phases in checkpoint order. The build fails if a SyncStage is missing. */
export const BACKFILL_PHASES = defineBackfillPhases([
  'metadata',
  'bodies',
  'drafts',
  'all-mail',
  'spam',
  'trash',
  'reconcile'
])

export type BackfillPhase = (typeof BACKFILL_PHASES)[number]

export interface ParsedCursor {
  phase: BackfillPhase
  pageToken?: string
}

function isBackfillPhase(value: string): value is BackfillPhase {
  return (BACKFILL_PHASES as readonly string[]).includes(value)
}

export function parseBackfillCursor(raw: string | null | undefined): ParsedCursor {
  if (!raw) return { phase: 'metadata' }

  // The dedicated SENT stage retired when the unfiltered all-mail stage
  // subsumed it. A profile resuming mid-`sent` restarts at all-mail because
  // the stored page token belongs to a SENT-scoped listing.
  if (raw === 'sent' || raw.startsWith('sent:')) return { phase: 'all-mail' }

  const separator = raw.indexOf(':')
  const phase = separator < 0 ? raw : raw.slice(0, separator)
  if (!isBackfillPhase(phase) || (phase === 'reconcile' && separator >= 0)) {
    throw new Error(`Invalid backfill cursor: ${raw}`)
  }
  return separator < 0 ? { phase } : { phase, pageToken: raw.slice(separator + 1) }
}
