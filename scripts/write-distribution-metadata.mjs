// Generates the packaged distribution metadata (T39, SPEC §6 Packaging).
// Runs before electron-builder in every package script. Default mode is
// personal (updater disabled); the release workflow opts in explicitly:
//
//   ATTN_DISTRIBUTION_MODE=release ATTN_RELEASE_FEED=owner/repo npm run package:mac
//
// The schema version is read from the schema snapshot so the metadata can
// never disagree with the build being packaged.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// This module is also imported by verify-package.mjs for packagedSchemaVersion,
// so writing the metadata is guarded on being run as the script.

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export function packagedSchemaVersion() {
  const schema = readFileSync(join(projectDir, 'src/main/db/schema.ts'), 'utf8')
  const match = schema.match(/CURRENT_SCHEMA_VERSION = (\d+)/)
  if (!match) throw new Error('CURRENT_SCHEMA_VERSION not found in src/main/db/schema.ts')
  return Number.parseInt(match[1], 10)
}

function buildMetadata() {
  const mode = process.env.ATTN_DISTRIBUTION_MODE ?? 'personal'
  const schemaVersion = packagedSchemaVersion()
  if (mode === 'personal') return { metadataVersion: 1, mode, schemaVersion }
  if (mode !== 'release') throw new Error(`unknown ATTN_DISTRIBUTION_MODE "${mode}"`)
  const feed = process.env.ATTN_RELEASE_FEED ?? ''
  const [owner, repo] = feed.split('/')
  if (!owner || !repo) {
    throw new Error('release packaging requires ATTN_RELEASE_FEED="owner/repo" (the update feed)')
  }
  return { metadataVersion: 1, mode, schemaVersion, feed: { owner, repo } }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const metadata = buildMetadata()
  const outputDir = join(projectDir, 'dist-resources')
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(join(outputDir, 'distribution.json'), `${JSON.stringify(metadata, null, 2)}\n`)
  console.log(`[package] distribution metadata: mode=${metadata.mode} schema=v${metadata.schemaVersion}`)
}
