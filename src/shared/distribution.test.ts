import { describe, expect, it } from 'vitest'
import { parseDistributionMetadata, shouldConstructUpdater, verifyDistributionMetadata } from './distribution'

const personal = { metadataVersion: 1, mode: 'personal', schemaVersion: 24 }
const release = {
  metadataVersion: 1,
  mode: 'release',
  schemaVersion: 24,
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
    expect(parseDistributionMetadata({ ...personal, metadataVersion: 2 })).toBeNull()
    expect(parseDistributionMetadata({ ...personal, mode: 'canary' })).toBeNull()
    expect(parseDistributionMetadata({ ...personal, schemaVersion: 0 })).toBeNull()
    expect(parseDistributionMetadata({ ...personal, schemaVersion: 1.5 })).toBeNull()
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

describe('verifyDistributionMetadata', () => {
  const options = { release: false, packagedSchemaVersion: 24 }

  it('a valid personal artifact passes without credentials', () => {
    expect(verifyDistributionMetadata(personal, options)).toEqual([])
  })

  it('a valid release artifact passes --release metadata checks', () => {
    expect(verifyDistributionMetadata(release, { ...options, release: true })).toEqual([])
  })

  it('a personal artifact presented to --release fails publication', () => {
    const errors = verifyDistributionMetadata(personal, { ...options, release: true })
    expect(errors.join(' ')).toMatch(/personal artifact cannot be published/)
  })

  it('a release artifact in a personal run fails rather than hiding an updater', () => {
    expect(verifyDistributionMetadata(release, options).join(' ')).toMatch(/mode "personal"/)
  })

  it('schema disagreement between metadata and the packaged build fails', () => {
    const errors = verifyDistributionMetadata(personal, { ...options, packagedSchemaVersion: 25 })
    expect(errors.join(' ')).toMatch(/schema v24.*v25/)
  })

  it('missing metadata fails both modes', () => {
    expect(verifyDistributionMetadata(undefined, options)).toHaveLength(1)
    expect(verifyDistributionMetadata(undefined, { ...options, release: true })).toHaveLength(1)
  })
})
