import { describe, expect, it } from 'vitest'
import { feedAssetNames, stampUpdateInfo } from './stamp-update-feed.mjs'

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

describe('stampUpdateInfo', () => {
  it('appends the schema stamp as one top-level key and changes nothing else', () => {
    const stamped = stampUpdateInfo(latestMac, { version: '0.2.0', schemaVersion: 27 })
    expect(stamped).toBe(`${latestMac}requiredSchemaVersion: 27\n`)
  })

  it('refuses a file built for another version, an existing stamp, or a bad schema', () => {
    expect(() => stampUpdateInfo(latestMac, { version: '0.3.0', schemaVersion: 27 })).toThrow(
      'declares version 0.2.0, expected 0.3.0'
    )
    const stamped = stampUpdateInfo(latestMac, { version: '0.2.0', schemaVersion: 27 })
    expect(() => stampUpdateInfo(stamped, { version: '0.2.0', schemaVersion: 27 })).toThrow('already stamped')
    expect(() => stampUpdateInfo(latestMac, { version: '0.2.0', schemaVersion: 0 })).toThrow(
      'positive integer'
    )
    expect(() => stampUpdateInfo('version: 0.2.0\n', { version: '0.2.0', schemaVersion: 27 })).toThrow(
      'no files block'
    )
  })
})

describe('feedAssetNames', () => {
  it('lists every url the feed points at, quoted or not', () => {
    expect(feedAssetNames(latestMac)).toEqual(['Attn-0.2.0-mac-arm64.zip', 'Attn-0.2.0-mac-x64.zip'])
    expect(feedAssetNames("files:\n  - url: 'Attn 0.2.0.exe'\n")).toEqual(['Attn 0.2.0.exe'])
  })
})
