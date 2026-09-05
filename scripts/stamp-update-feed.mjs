#!/usr/bin/env node
// Prepares electron-updater's latest.yml and latest-mac.yml before the release
// workflow uploads them to the rolling update feed (T39, SPEC §6 Packaging):
//
//   node scripts/stamp-update-feed.mjs <dir> --assets-base <url> [--current <dir>]
//
// - `requiredSchemaVersion` and `minimumSchemaVersion` are read from
//   src/main/db/schema.ts. Together they describe the target schema and the
//   oldest profile that target can migrate.
// - Every `url:` / `path:` becomes an absolute URL under --assets-base (the
//   versioned release's download directory). Relative names would otherwise
//   resolve against the rolling feed release.
// - Each file's `version:` must equal package.json's, must be a plain
//   `major.minor.patch`, and — with --current, the directory holding the feed
//   files currently published, must be newer than what the feed already
//   offers, so a re-run of an older tag cannot roll the feed back.
//
// The feed files are flat YAML maps electron-builder writes; they are edited
// line by line rather than re-serialized so nothing else in them changes.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packagedSchemaVersions } from './write-distribution-metadata.mjs'

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The feed file names electron-builder emits for the two shipping targets. */
export const UPDATE_INFO_FILES = ['latest.yml', 'latest-mac.yml']

const RELEASE_VERSION = /^\d+\.\d+\.\d+$/

/** Plain `major.minor.patch` only — the updater's comparison rejects anything else. */
export function isReleaseVersion(version) {
  return RELEASE_VERSION.test(version)
}

/** True when `candidate` is a strictly newer release version than `current`. */
export function isNewerReleaseVersion(candidate, current) {
  if (!isReleaseVersion(candidate) || !isReleaseVersion(current)) return false
  const left = candidate.split('.').map(Number)
  const right = current.split('.').map(Number)
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] > right[index]
  }
  return false
}

function unquote(value) {
  return value.trim().replace(/^['"]|['"]$/g, '')
}

/** The top-level `version:` of a feed file, or null. */
export function feedVersion(text) {
  const line = text.split('\n').find((candidate) => candidate.startsWith('version:'))
  return line ? unquote(line.slice('version:'.length)) : null
}

/** Every `url:` in the feed, quoted or not, top-level or inside `files:`. */
export function feedAssetNames(text) {
  return text
    .split('\n')
    .map((line) => line.match(/^\s*(?:-\s+)?url:\s*(.+?)\s*$/))
    .filter((match) => match !== null)
    .map((match) => unquote(match[1]))
}

/**
 * Return the stamped text of one feed file. Throws when the file is not the
 * expected shape: a different or non-release version, an existing stamp, no
 * `files:` block, or an asset that is already absolute (stamped twice).
 */
export function stampUpdateInfo(text, { version, schemaVersion, minimumSchemaVersion, assetsBase }) {
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion <= 0) {
    throw new Error(`schema version must be a positive integer, got ${schemaVersion}`)
  }
  if (
    !Number.isSafeInteger(minimumSchemaVersion) ||
    minimumSchemaVersion <= 0 ||
    minimumSchemaVersion > schemaVersion
  ) {
    throw new Error(
      `minimum schema version must be a positive integer no newer than v${schemaVersion}, got ${minimumSchemaVersion}`
    )
  }
  if (!isReleaseVersion(version)) throw new Error(`${version} is not a release version (major.minor.patch)`)
  if (!/^https:\/\/\S+$/.test(assetsBase))
    throw new Error(`assets base must be an https URL, got ${assetsBase}`)
  const lines = text.split('\n')
  const topLevel = (key) => lines.find((line) => line.startsWith(`${key}:`))
  const declared = feedVersion(text)
  if (declared === null) throw new Error('feed file has no top-level version')
  if (declared !== version) throw new Error(`feed file declares version ${declared}, expected ${version}`)
  if (topLevel('requiredSchemaVersion') || topLevel('minimumSchemaVersion')) {
    throw new Error('feed file is already stamped')
  }
  if (!topLevel('files')) throw new Error('feed file has no files block')
  const base = assetsBase.endsWith('/') ? assetsBase : `${assetsBase}/`
  const absolute = (name) => {
    if (/^[a-z]+:\/\//i.test(name)) throw new Error(`asset ${name} is already absolute; stamped twice?`)
    return `${base}${encodeURIComponent(name)}`
  }
  const rewritten = lines.map((line) => {
    const match = line.match(/^(\s*(?:-\s+)?(?:url|path):\s*)(.+?)\s*$/)
    return match ? `${match[1]}${absolute(unquote(match[2]))}` : line
  })
  const body = rewritten.join('\n')
  return `${body.endsWith('\n') ? body : `${body}\n`}requiredSchemaVersion: ${schemaVersion}\nminimumSchemaVersion: ${minimumSchemaVersion}\n`
}

function parseArguments(argv) {
  const options = { directory: null, assetsBase: null, current: [] }
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--assets-base') options.assetsBase = argv[++index]
    else if (argument === '--current') options.current.push(argv[++index])
    else if (options.directory === null) options.directory = argument
    else throw new Error(`unexpected argument ${argument}`)
  }
  if (!options.directory || !options.assetsBase) {
    throw new Error('usage: node scripts/stamp-update-feed.mjs <dir> --assets-base <url> [--current <dir>]')
  }
  return options
}

export function stampDirectory({ directory, assetsBase, current }) {
  const version = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')).version
  const { schemaVersion, minimumSchemaVersion } = packagedSchemaVersions()
  const present = UPDATE_INFO_FILES.filter((name) => existsSync(join(directory, name)))
  if (present.length === 0) {
    throw new Error(`no ${UPDATE_INFO_FILES.join(' or ')} in ${directory}; nothing to publish`)
  }
  const siblings = new Set(readdirSync(directory))
  for (const name of present) {
    const path = join(directory, name)
    const text = readFileSync(path, 'utf8')
    for (const asset of feedAssetNames(text)) {
      if (!siblings.has(asset)) throw new Error(`${name} names ${asset}, which is not in ${directory}`)
    }
    const currentDirectories = current ? (Array.isArray(current) ? current : [current]) : []
    for (const currentDirectory of currentDirectories) {
      const currentPath = join(currentDirectory, name)
      if (!existsSync(currentPath)) throw new Error(`current feed is missing ${name}`)
      const published = feedVersion(readFileSync(currentPath, 'utf8'))
      if (published === null || !isReleaseVersion(published)) {
        throw new Error(`${name}: current feed has no valid release version`)
      }
      if (!isNewerReleaseVersion(version, published)) {
        throw new Error(`${name}: the feed already offers ${published}; ${version} is not newer`)
      }
    }
    writeFileSync(path, stampUpdateInfo(text, { version, schemaVersion, minimumSchemaVersion, assetsBase }))
    console.log(
      `[release] ${name}: version ${version}, schemas ${minimumSchemaVersion}..${schemaVersion}, assets at ${assetsBase}`
    )
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2))
  stampDirectory({
    directory: resolve(options.directory),
    assetsBase: options.assetsBase,
    current: options.current.map((directory) => resolve(directory))
  })
}
