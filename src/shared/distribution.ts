// Distribution metadata (T39, SPEC §6 Packaging): a small JSON document
// packaged beside the app that declares how this build may behave. Personal
// builds (the default, and anything missing or malformed) never construct an
// updater; only an explicit release build with a declared feed checks GitHub
// Releases. `app.isPackaged` alone never enables updates.

export const DISTRIBUTION_METADATA_FILE = 'distribution.json'
const DISTRIBUTION_METADATA_VERSION = 2
export const UPDATE_FEED_TAG = 'update-feed'

// Auto-update state shared across processes. The renderer only receives this
// snapshot, and no state can force a restart without an explicit command.
export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready'

/** How the most recent completed check ended. */
export type UpdateCheckOutcome = 'up-to-date' | 'available' | 'incompatible' | 'error'

export interface UpdateCheck {
  /** Wall-clock milliseconds when the check finished. */
  at: number
  outcome: UpdateCheckOutcome
  /** The feed's newest version for 'available' and 'incompatible'; null otherwise. */
  version: string | null
}

export interface UpdateState {
  phase: UpdatePhase
  /** The downloaded-and-ready version, when phase is 'ready'. */
  readyVersion: string | null
  /** The last completed check; null until one finishes (or forever without an updater). */
  lastCheck: UpdateCheck | null
}

export const UPDATE_STATE_IDLE: UpdateState = { phase: 'idle', readyVersion: null, lastCheck: null }

type DistributionMode = 'personal' | 'release'

/** What kind of build is running, for the About surface (F15). */
export type DistributionKind = 'development' | DistributionMode

export interface AppInfo {
  version: string
  schemaVersion: number
  distribution: DistributionKind
  /** The GitHub Releases feed as `owner/repo`; only a release build has one. */
  feed: string | null
  /** True when an updater was constructed: release, packaged, not under the harness. */
  updaterActive: boolean
}

/**
 * The one-line update status Settings shows and the palette toasts (F15
 * About). Pure so both surfaces say the same thing about the same state.
 */
export function describeUpdateStatus(info: AppInfo | null, state: UpdateState, now: number): string {
  // A downloaded update is the state that matters most, whatever produced it.
  if (state.phase === 'ready' && state.readyVersion) {
    return `Version ${state.readyVersion} is downloaded. It installs when you quit, or restart now.`
  }
  if (info === null) return 'Loading…'
  if (!info.updaterActive) {
    if (info.distribution === 'release') return 'Updates are paused in this session.'
    if (info.distribution === 'development') return 'Development builds never check for updates.'
    return 'Personal builds never update themselves — install a newer build over this one.'
  }
  if (state.phase === 'checking') return 'Checking for updates…'
  if (state.phase === 'downloading') {
    return state.lastCheck?.version
      ? `Downloading ${state.lastCheck.version} in the background…`
      : 'Downloading an update in the background…'
  }
  const check = state.lastCheck
  if (check === null) return 'Not checked yet.'
  const when = describeCheckedAt(check.at, now)
  switch (check.outcome) {
    case 'up-to-date':
      return `Up to date — checked ${when}.`
    case 'available':
      return `Version ${check.version} is available — checked ${when}.`
    case 'incompatible':
      return `Version ${check.version} cannot migrate this database automatically, so it will not install. See the release notes.`
    case 'error':
      return `Could not reach the update feed — tried ${when}. Attn retries on its own.`
  }
}

/** "just now", "5 minutes ago", "3 hours ago", or "yesterday" — enough for a status line. */
export function describeCheckedAt(at: number, now: number): string {
  const elapsedMs = Math.max(0, now - at)
  const minutes = Math.floor(elapsedMs / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`
  const days = Math.floor(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

export interface DistributionMetadata {
  metadataVersion: number
  mode: DistributionMode
  /** The schema snapshot this build runs. */
  schemaVersion: number
  /** The oldest existing profile this build can migrate to schemaVersion. */
  minimumSchemaVersion: number
  /** Release feed location; required in release mode, absent in personal. */
  feed?: { owner: string; repo: string }
}

/**
 * The rolling feed release. Its latest.yml / latest-mac.yml entries point at
 * versioned release assets and declare the target and minimum input schemas.
 */
export function updateFeedUrl(feed: { owner: string; repo: string }): string {
  return `https://github.com/${feed.owner}/${feed.repo}/releases/download/${UPDATE_FEED_TAG}`
}

function isFeed(value: unknown): value is { owner: string; repo: string } {
  if (!value || typeof value !== 'object') return false
  const feed = value as Partial<{ owner: string; repo: string }>
  return (
    typeof feed.owner === 'string' &&
    feed.owner.length > 0 &&
    typeof feed.repo === 'string' &&
    feed.repo.length > 0
  )
}

/**
 * Parse packaged metadata strictly. Anything unexpected — wrong version,
 * unknown mode, bad schema number, a release build without a feed — returns
 * null, and null means personal behavior: no updater, ever.
 */
export function parseDistributionMetadata(value: unknown): DistributionMetadata | null {
  if (!value || typeof value !== 'object') return null
  const metadata = value as Partial<DistributionMetadata>
  if (metadata.metadataVersion !== DISTRIBUTION_METADATA_VERSION) return null
  if (metadata.mode !== 'personal' && metadata.mode !== 'release') return null
  if (
    typeof metadata.schemaVersion !== 'number' ||
    !Number.isSafeInteger(metadata.schemaVersion) ||
    metadata.schemaVersion <= 0
  ) {
    return null
  }
  if (
    typeof metadata.minimumSchemaVersion !== 'number' ||
    !Number.isSafeInteger(metadata.minimumSchemaVersion) ||
    metadata.minimumSchemaVersion <= 0 ||
    metadata.minimumSchemaVersion > metadata.schemaVersion
  ) {
    return null
  }
  if (metadata.mode === 'release') {
    if (!isFeed(metadata.feed)) return null
    return {
      metadataVersion: DISTRIBUTION_METADATA_VERSION,
      mode: 'release',
      schemaVersion: metadata.schemaVersion,
      minimumSchemaVersion: metadata.minimumSchemaVersion,
      feed: { owner: metadata.feed.owner, repo: metadata.feed.repo }
    }
  }
  if (metadata.feed !== undefined) return null
  return {
    metadataVersion: DISTRIBUTION_METADATA_VERSION,
    mode: 'personal',
    schemaVersion: metadata.schemaVersion,
    minimumSchemaVersion: metadata.minimumSchemaVersion
  }
}

/**
 * The one gate for constructing an updater (T39): an explicit release build,
 * actually packaged, and never under the e2e/seed harness. Personal, dev,
 * seeded, and missing/invalid-metadata builds construct nothing and make
 * zero feed requests.
 */
export function shouldConstructUpdater(
  metadata: DistributionMetadata | null,
  packaged: boolean,
  seeded: boolean
): metadata is DistributionMetadata {
  return metadata !== null && metadata.mode === 'release' && packaged && !seeded
}
