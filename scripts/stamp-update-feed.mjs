#!/usr/bin/env node
// Stamps `requiredSchemaVersion` into the electron-updater feed files
// (latest.yml, latest-mac.yml) before the release workflow uploads them (T39,
// SPEC §6 Packaging). The updater rejects any release whose feed entry lacks
// the key or names another schema, so a feed file that reaches GitHub without
// this stamp is an update nobody can install — the workflow runs this step
// between the build and the upload, and refuses to continue when it fails.
//
//   node scripts/stamp-update-feed.mjs <directory holding latest*.yml>
//
// The schema version is read from src/main/db/schema.ts at the same commit
// the artifacts were built from, and each file's `version:` must equal
// package.json's, so a stale artifact from another build cannot be published
// under this version. The feed files are flat YAML maps whose top level
// electron-builder writes; a top-level key is appended rather than re-serialized
// so nothing else in the file changes.

import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { packagedSchemaVersion } from './write-distribution-metadata.mjs'

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The feed file names electron-builder emits for the two shipping targets. */
export const UPDATE_INFO_FILES = ['latest.yml', 'latest-mac.yml']

/**
 * Return the stamped text of one feed file. Throws when the file is not the
 * expected shape: a different version, an existing stamp, or no `files:` block.
 */
export function stampUpdateInfo(text, { version, schemaVersion }) {
  if (!Number.isSafeInteger(schemaVersion) || schemaVersion <= 0) {
    throw new Error(`schema version must be a positive integer, got ${schemaVersion}`)
  }
  const lines = text.split('\n')
  const topLevel = (key) => lines.find((line) => line.startsWith(`${key}:`))
  const versionLine = topLevel('version')
  if (!versionLine) throw new Error('feed file has no top-level version')
  const declared = versionLine
    .slice('version:'.length)
    .trim()
    .replace(/^['"]|['"]$/g, '')
  if (declared !== version) {
    throw new Error(`feed file declares version ${declared}, expected ${version}`)
  }
  if (topLevel('requiredSchemaVersion')) throw new Error('feed file is already stamped')
  if (!topLevel('files')) throw new Error('feed file has no files block')
  const body = text.endsWith('\n') ? text : `${text}\n`
  return `${body}requiredSchemaVersion: ${schemaVersion}\n`
}

/** Every `url:` in the feed must name a file that sits beside it. */
export function feedAssetNames(text) {
  return text
    .split('\n')
    .map((line) => line.match(/^\s*(?:-\s+)?url:\s*(.+?)\s*$/))
    .filter((match) => match !== null)
    .map((match) => match[1].replace(/^['"]|['"]$/g, ''))
}

function stampDirectory(directory) {
  const version = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')).version
  const schemaVersion = packagedSchemaVersion()
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
    writeFileSync(path, stampUpdateInfo(text, { version, schemaVersion }))
    console.log(`[release] ${name}: version ${version}, requiredSchemaVersion ${schemaVersion}`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2]
  if (!directory) throw new Error('usage: node scripts/stamp-update-feed.mjs <directory>')
  stampDirectory(resolve(directory))
}
