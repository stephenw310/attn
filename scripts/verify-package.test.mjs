import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { verifyDistributionMetadata } from './verify-package.mjs'
import { packagedSchemaVersions } from './write-distribution-metadata.mjs'

const versions = packagedSchemaVersions()
const personal = { metadataVersion: 2, mode: 'personal', ...versions }
const release = { ...personal, mode: 'release', feed: { owner: 'stephenw310', repo: 'attn' } }
let directory
let archive

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'attn-package-metadata-'))
  archive = join(directory, 'app.asar')
})

afterEach(() => rmSync(directory, { recursive: true, force: true }))

describe('packaged distribution metadata', () => {
  it.each([
    [personal, false],
    [release, true]
  ])('accepts metadata beside the archive in its declared mode', async (metadata, releaseMode) => {
    writeFileSync(join(directory, 'distribution.json'), JSON.stringify(metadata))
    await expect(verifyDistributionMetadata(archive, releaseMode)).resolves.toBeUndefined()
  })

  it.each([
    [{ ...personal, metadataVersion: 3 }, false, 'unknown metadataVersion'],
    [{ ...personal, schemaVersion: versions.schemaVersion + 1 }, false, 'packaged build is'],
    [{ ...personal, minimumSchemaVersion: versions.minimumSchemaVersion + 1 }, false, 'minimum schema'],
    [personal, true, 'personal artifact cannot be published'],
    [release, false, 'personal packaging must declare'],
    [{ ...personal, feed: release.feed }, false, 'with no feed'],
    [{ ...release, feed: undefined }, true, 'must declare its update feed'],
    [{ ...release, feed: { owner: 'stephenw310' } }, true, 'must declare its update feed']
  ])('rejects incompatible packaged metadata', async (metadata, releaseMode, message) => {
    writeFileSync(join(directory, 'distribution.json'), JSON.stringify(metadata))
    await expect(verifyDistributionMetadata(archive, releaseMode)).rejects.toThrow(message)
  })

  it('rejects missing or unreadable metadata in both modes', async () => {
    for (const releaseMode of [false, true]) {
      await expect(verifyDistributionMetadata(archive, releaseMode)).rejects.toThrow(
        'no readable distribution.json beside app.asar'
      )
    }
    writeFileSync(join(directory, 'distribution.json'), '{broken')
    await expect(verifyDistributionMetadata(archive)).rejects.toThrow('no readable distribution.json')
  })
})
