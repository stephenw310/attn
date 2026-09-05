import { describe, expect, it } from 'vitest'
import {
  type AppInfo,
  describeCheckedAt,
  describeUpdateStatus,
  parseDistributionMetadata,
  shouldConstructUpdater,
  UPDATE_FEED_TAG,
  UPDATE_STATE_IDLE,
  updateFeedUrl
} from './distribution'

const personal = { metadataVersion: 2, mode: 'personal', schemaVersion: 24, minimumSchemaVersion: 21 }
const release = {
  metadataVersion: 2,
  mode: 'release',
  schemaVersion: 24,
  minimumSchemaVersion: 21,
  feed: { owner: 'stephenw310', repo: 'attn' }
}

describe('parseDistributionMetadata', () => {
  it('parses the two valid shapes', () => {
    expect(parseDistributionMetadata(personal)).toEqual(personal)
    expect(parseDistributionMetadata(release)).toEqual(release)
  })

  it('rejects everything else as null (which means personal, updater off)', () => {
    expect(parseDistributionMetadata(null)).toBeNull()
    expect(parseDistributionMetadata({})).toBeNull()
    expect(parseDistributionMetadata({ ...personal, metadataVersion: 3 })).toBeNull()
    expect(parseDistributionMetadata({ ...personal, mode: 'canary' })).toBeNull()
    expect(parseDistributionMetadata({ ...personal, schemaVersion: 0 })).toBeNull()
    expect(parseDistributionMetadata({ ...personal, schemaVersion: 1.5 })).toBeNull()
    expect(parseDistributionMetadata({ ...personal, minimumSchemaVersion: 0 })).toBeNull()
    expect(parseDistributionMetadata({ ...personal, minimumSchemaVersion: 25 })).toBeNull()
    // A release build without a feed has nowhere valid to update from.
    expect(parseDistributionMetadata({ ...release, feed: undefined })).toBeNull()
    expect(parseDistributionMetadata({ ...release, feed: { owner: '', repo: 'attn' } })).toBeNull()
    // A personal build declaring a feed is malformed, not quietly trusted.
    expect(parseDistributionMetadata({ ...personal, feed: release.feed })).toBeNull()
  })
})

describe('shouldConstructUpdater', () => {
  it('requires release metadata, a packaged app, and no test seam', () => {
    const releaseMeta = parseDistributionMetadata(release)
    expect(shouldConstructUpdater(releaseMeta, true, false)).toBe(true)
    expect(shouldConstructUpdater(releaseMeta, false, false)).toBe(false)
    expect(shouldConstructUpdater(releaseMeta, true, true)).toBe(false)
    expect(shouldConstructUpdater(parseDistributionMetadata(personal), true, false)).toBe(false)
    expect(shouldConstructUpdater(null, true, false)).toBe(false)
  })
})

describe('describeUpdateStatus', () => {
  const releaseInfo: AppInfo = {
    version: '1.0.0',
    schemaVersion: 24,
    distribution: 'release',
    feed: 'stephenw310/attn',
    updaterActive: true
  }
  const now = 10 * 60_000

  it('explains builds that never check', () => {
    expect(describeUpdateStatus(null, UPDATE_STATE_IDLE, now)).toBe('Loading…')
    expect(
      describeUpdateStatus(
        { ...releaseInfo, distribution: 'development', updaterActive: false },
        UPDATE_STATE_IDLE,
        now
      )
    ).toContain('Development builds never check')
    expect(
      describeUpdateStatus(
        { ...releaseInfo, distribution: 'personal', updaterActive: false },
        UPDATE_STATE_IDLE,
        now
      )
    ).toContain('Personal builds never update themselves')
  })

  it('follows the phase, then the last check', () => {
    expect(describeUpdateStatus(releaseInfo, UPDATE_STATE_IDLE, now)).toBe('Not checked yet.')
    expect(describeUpdateStatus(releaseInfo, { ...UPDATE_STATE_IDLE, phase: 'checking' }, now)).toBe(
      'Checking for updates…'
    )
    expect(
      describeUpdateStatus(
        releaseInfo,
        {
          phase: 'downloading',
          readyVersion: null,
          lastCheck: { at: now, outcome: 'available', version: '1.1.0' }
        },
        now
      )
    ).toBe('Downloading 1.1.0 in the background…')
    expect(
      describeUpdateStatus(
        releaseInfo,
        {
          phase: 'ready',
          readyVersion: '1.1.0',
          lastCheck: { at: now, outcome: 'available', version: '1.1.0' }
        },
        now
      )
    ).toContain('Version 1.1.0 is downloaded')
    expect(
      describeUpdateStatus(
        releaseInfo,
        { ...UPDATE_STATE_IDLE, lastCheck: { at: now - 5 * 60_000, outcome: 'up-to-date', version: null } },
        now
      )
    ).toBe('Up to date — checked 5 minutes ago.')
    expect(
      describeUpdateStatus(
        releaseInfo,
        { ...UPDATE_STATE_IDLE, lastCheck: { at: now, outcome: 'incompatible', version: '2.0.0' } },
        now
      )
    ).toContain('Version 2.0.0 cannot migrate this database automatically')
    expect(
      describeUpdateStatus(
        releaseInfo,
        { ...UPDATE_STATE_IDLE, lastCheck: { at: now, outcome: 'error', version: null } },
        now
      )
    ).toContain('Could not reach the update feed')
  })
})

describe('describeCheckedAt', () => {
  it('rounds down to the coarsest unit that reads naturally', () => {
    const now = 100 * 3_600_000
    expect(describeCheckedAt(now, now)).toBe('just now')
    expect(describeCheckedAt(now - 59_000, now)).toBe('just now')
    expect(describeCheckedAt(now - 60_000, now)).toBe('1 minute ago')
    expect(describeCheckedAt(now - 59 * 60_000, now)).toBe('59 minutes ago')
    expect(describeCheckedAt(now - 3_600_000, now)).toBe('1 hour ago')
    expect(describeCheckedAt(now - 25 * 3_600_000, now)).toBe('yesterday')
    expect(describeCheckedAt(now - 72 * 3_600_000, now)).toBe('3 days ago')
    // A clock that went backwards never reads as the future.
    expect(describeCheckedAt(now + 5_000, now)).toBe('just now')
  })
})

describe('update feed location', () => {
  it('names the one rolling release the workflow maintains', () => {
    expect(UPDATE_FEED_TAG).toBe('update-feed')
    expect(updateFeedUrl({ owner: 'stephenw310', repo: 'attn' })).toBe(
      'https://github.com/stephenw310/attn/releases/download/update-feed'
    )
  })
})
