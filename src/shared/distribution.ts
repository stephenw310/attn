// Distribution metadata (T39, SPEC §6 Packaging): a small JSON document
// packaged beside the app that declares how this build may behave. Personal
// builds (the default, and anything missing or malformed) never construct an
// updater; only an explicit release build with a declared feed checks GitHub
// Releases. `app.isPackaged` alone never enables updates.

export const DISTRIBUTION_METADATA_FILE = 'distribution.json'
const DISTRIBUTION_METADATA_VERSION = 1

// Auto-update state shared across processes. The renderer only receives this
// snapshot, and no state can force a restart without an explicit command.
export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready'

export interface UpdateState {
  phase: UpdatePhase
  /** The downloaded-and-ready version, when phase is 'ready'. */
  readyVersion: string | null
}

export const UPDATE_STATE_IDLE: UpdateState = { phase: 'idle', readyVersion: null }

type DistributionMode = 'personal' | 'release'

export interface DistributionMetadata {
  metadataVersion: number
  mode: DistributionMode
  /** The schema snapshot this build runs; updates never cross it. */
  schemaVersion: number
  /** Release feed location; required in release mode, absent in personal. */
  feed?: { owner: string; repo: string }
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
  if (metadata.mode === 'release') {
    if (!isFeed(metadata.feed)) return null
    return {
      metadataVersion: DISTRIBUTION_METADATA_VERSION,
      mode: 'release',
      schemaVersion: metadata.schemaVersion,
      feed: { owner: metadata.feed.owner, repo: metadata.feed.repo }
    }
  }
  if (metadata.feed !== undefined) return null
  return {
    metadataVersion: DISTRIBUTION_METADATA_VERSION,
    mode: 'personal',
    schemaVersion: metadata.schemaVersion
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

/**
 * Metadata-level verification shared by `package:verify` and its `--release`
 * mode: what a valid personal or release build must declare. Returns the
 * failures; an empty list is a pass. Signature and notarization checks are
 * the release workflow's OS-level additions on top of this.
 */
export function verifyDistributionMetadata(
  raw: unknown,
  options: { release: boolean; packagedSchemaVersion: number }
): string[] {
  const errors: string[] = []
  const metadata = parseDistributionMetadata(raw)
  if (metadata === null) {
    errors.push('distribution metadata is missing or malformed')
    return errors
  }
  if (metadata.schemaVersion !== options.packagedSchemaVersion) {
    errors.push(
      `distribution metadata declares schema v${metadata.schemaVersion} but the packaged build is v${options.packagedSchemaVersion}`
    )
  }
  if (options.release && metadata.mode !== 'release') {
    errors.push('a personal artifact cannot be published: --release requires mode "release"')
  }
  if (!options.release && metadata.mode !== 'personal') {
    errors.push('personal packaging must declare mode "personal" (updater disabled)')
  }
  return errors
}
