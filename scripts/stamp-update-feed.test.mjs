import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  feedAssetNames,
  feedVersion,
  isNewerReleaseVersion,
  stampDirectory,
  stampUpdateInfo
} from './stamp-update-feed.mjs'

const latestMac = `version: 0.2.0
files:
  - url: Attn-0.2.0-mac-arm64.zip
    sha512: abc
    size: 1
  - url: Attn-0.2.0-mac-x64.zip
    sha512: def
    size: 2
path: Attn-0.2.0-mac-arm64.zip
sha512: abc
releaseDate: '2026-09-04T00:00:00.000Z'
`
const base = 'https://github.com/stephenw310/attn/releases/download/v0.2.0'
const stamp = (text, overrides = {}) =>
  stampUpdateInfo(text, {
    version: '0.2.0',
    schemaVersion: 27,
    minimumSchemaVersion: 21,
    assetsBase: base,
    ...overrides
  })

const temporaryDirectories = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

function feedDirectories(currentText) {
  const root = mkdtempSync(join(tmpdir(), 'attn-feed-'))
  temporaryDirectories.push(root)
  const release = join(root, 'release')
  const current = join(root, 'current')
  mkdirSync(release)
  mkdirSync(current)
  const file = `version: 0.0.1
files:
  - url: Attn.exe
path: Attn.exe
`
  writeFileSync(join(release, 'latest.yml'), file)
  writeFileSync(join(release, 'Attn.exe'), 'installer')
  if (currentText !== null) writeFileSync(join(current, 'latest.yml'), currentText)
  return { release, current }
}

describe('stampUpdateInfo', () => {
  it('points every asset at the versioned release and appends the schema stamp', () => {
    expect(stamp(latestMac)).toBe(`version: 0.2.0
files:
  - url: ${base}/Attn-0.2.0-mac-arm64.zip
    sha512: abc
    size: 1
  - url: ${base}/Attn-0.2.0-mac-x64.zip
    sha512: def
    size: 2
path: ${base}/Attn-0.2.0-mac-arm64.zip
sha512: abc
releaseDate: '2026-09-04T00:00:00.000Z'
requiredSchemaVersion: 27
minimumSchemaVersion: 21
`)
  })

  it('refuses another version, a prerelease, a double stamp, or a bad schema', () => {
    expect(() => stamp(latestMac, { version: '0.3.0' })).toThrow('declares version 0.2.0, expected 0.3.0')
    expect(() => stamp(latestMac, { version: '0.2.0-beta.1' })).toThrow('not a release version')
    expect(() => stamp(stamp(latestMac))).toThrow('already stamped')
    expect(() => stamp(latestMac, { schemaVersion: 0 })).toThrow('positive integer')
    expect(() => stamp(latestMac, { minimumSchemaVersion: 0 })).toThrow('minimum schema version')
    expect(() => stamp(latestMac, { minimumSchemaVersion: 28 })).toThrow('minimum schema version')
    expect(() => stamp(latestMac, { assetsBase: 'ftp://x' })).toThrow('https URL')
    expect(() => stamp('version: 0.2.0\n')).toThrow('no files block')
  })
})

describe('feed helpers', () => {
  it('reads the version and every url, quoted or not', () => {
    expect(feedVersion(latestMac)).toBe('0.2.0')
    expect(feedVersion("version: '1.2.3'\n")).toBe('1.2.3')
    expect(feedAssetNames(latestMac)).toEqual(['Attn-0.2.0-mac-arm64.zip', 'Attn-0.2.0-mac-x64.zip'])
    expect(feedAssetNames("files:\n  - url: 'Attn 0.2.0.exe'\n")).toEqual(['Attn 0.2.0.exe'])
  })

  it('orders release versions numerically and never accepts a prerelease', () => {
    expect(isNewerReleaseVersion('0.10.0', '0.9.1')).toBe(true)
    expect(isNewerReleaseVersion('0.9.1', '0.9.1')).toBe(false)
    expect(isNewerReleaseVersion('0.9.0', '0.9.1')).toBe(false)
    expect(isNewerReleaseVersion('1.0.0-beta.1', '0.9.1')).toBe(false)
  })
})

describe('current feed guard', () => {
  const assetsBase = 'https://github.com/stephenw310/attn/releases/download/v0.0.1'

  it('fails when an existing rolling release is missing a platform feed', () => {
    const directories = feedDirectories(null)
    expect(() =>
      stampDirectory({ directory: directories.release, assetsBase, current: directories.current })
    ).toThrow('current feed is missing latest.yml')
  })

  it('fails when the published feed has no valid release version', () => {
    const directories = feedDirectories('version: broken\n')
    expect(() =>
      stampDirectory({ directory: directories.release, assetsBase, current: directories.current })
    ).toThrow('current feed has no valid release version')
  })

  it('fails when the published feed is not older', () => {
    const directories = feedDirectories('version: 0.0.2\n')
    expect(() =>
      stampDirectory({ directory: directories.release, assetsBase, current: directories.current })
    ).toThrow('the feed already offers 0.0.2; 0.0.1 is not newer')
  })
})
