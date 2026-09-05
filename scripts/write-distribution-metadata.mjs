// Generates the packaged distribution metadata (T39, SPEC §6 Packaging).
// Runs before electron-builder in every package script. Default mode is
// personal (updater disabled); the release workflow opts in explicitly:
//
//   ATTN_DISTRIBUTION_MODE=release ATTN_RELEASE_FEED=owner/repo npm run package:mac
//
// The current and minimum migratable schema versions are read from the schema
// snapshot so packaged metadata and update-feed compatibility stay aligned.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// This module is also imported by verify-package.mjs for packagedSchemaVersion,
// so writing the metadata is guarded on being run as the script.

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function packagedSchemaVersions() {
  const schema = readFileSync(join(projectDir, 'src/main/db/schema.ts'), 'utf8')
  const current = schema.match(/CURRENT_SCHEMA_VERSION = (\d+)/)
  const minimum = schema.match(/MINIMUM_MIGRATABLE_SCHEMA_VERSION = (\d+)/)
  if (!current) throw new Error('CURRENT_SCHEMA_VERSION not found in src/main/db/schema.ts')
  if (!minimum) throw new Error('MINIMUM_MIGRATABLE_SCHEMA_VERSION not found in src/main/db/schema.ts')
  const versions = {
    schemaVersion: Number.parseInt(current[1], 10),
    minimumSchemaVersion: Number.parseInt(minimum[1], 10)
  }
  if (versions.minimumSchemaVersion > versions.schemaVersion) {
    throw new Error('MINIMUM_MIGRATABLE_SCHEMA_VERSION cannot exceed CURRENT_SCHEMA_VERSION')
  }
  return versions
}

export function packagedSchemaVersion() {
  return packagedSchemaVersions().schemaVersion
}

function buildMetadata() {
  const mode = process.env.ATTN_DISTRIBUTION_MODE ?? 'personal'
  const { schemaVersion, minimumSchemaVersion } = packagedSchemaVersions()
  const common = { metadataVersion: 2, schemaVersion, minimumSchemaVersion }
  if (mode === 'personal') return { ...common, mode }
  if (mode !== 'release') throw new Error(`unknown ATTN_DISTRIBUTION_MODE "${mode}"`)
  const feed = process.env.ATTN_RELEASE_FEED ?? ''
  const [owner, repo] = feed.split('/')
  if (!owner || !repo) {
    throw new Error('release packaging requires ATTN_RELEASE_FEED="owner/repo" (the update feed)')
  }
  return { ...common, mode, feed: { owner, repo } }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const metadata = buildMetadata()
  const outputDir = join(projectDir, 'dist-resources')
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(join(outputDir, 'distribution.json'), `${JSON.stringify(metadata, null, 2)}\n`)
  console.log(`[package] distribution metadata: mode=${metadata.mode} schema=v${metadata.schemaVersion}`)
}
