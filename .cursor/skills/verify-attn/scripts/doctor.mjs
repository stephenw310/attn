#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { newestMtime } from './fs.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../..')
const failures = []
const notes = []
const check = (ok, message) => (ok ? notes.push(`ok    ${message}`) : failures.push(`FAIL  ${message}`))

const [major, minor] = process.versions.node.split('.').map(Number)
check(major > 22 || (major === 22 && minor >= 12), `node ${process.versions.node} (need >= 22.12)`)

const built = ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']
const missing = built.filter((file) => !existsSync(join(ROOT, file)))
check(
  missing.length === 0,
  missing.length ? `build missing ${missing.join(', ')}; run npm run build` : 'build present'
)

if (missing.length === 0) {
  const builtAt = statSync(join(ROOT, 'out/main/index.js')).mtimeMs
  const newest = newestMtime(join(ROOT, 'src'))
  check(
    newest.mtime <= builtAt,
    newest.mtime <= builtAt
      ? 'out/ is newer than every file in src/'
      : `out/ is stale; ${newest.path} changed after the build. Run npm run build`
  )
}

const pathFile = join(ROOT, 'node_modules/electron/path.txt')
const electronBinary = existsSync(pathFile)
  ? join(ROOT, 'node_modules/electron/dist', readFileSync(pathFile, 'utf8').trim())
  : null
check(electronBinary !== null && existsSync(electronBinary), `electron binary ${electronBinary ?? 'missing'}`)

const sqliteCandidates = [
  join(ROOT, `node_modules/better-sqlite3/prebuilds/${process.platform}-${process.arch}.node`),
  join(ROOT, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node')
]
const sqlite = sqliteCandidates.find((candidate) => existsSync(candidate))
check(
  sqlite !== undefined,
  sqlite ? `better-sqlite3 ${sqlite}` : 'better-sqlite3 binary missing; run npm run toolchain'
)

const stale = readdirSync(tmpdir()).filter((name) => name.startsWith('attn-e2e-'))
notes.push(
  stale.length === 0
    ? 'ok    no leftover attn-e2e-* profiles in tmpdir'
    : `note  ${stale.length} leftover attn-e2e-* profiles in ${tmpdir()}; scripts/cleanup.mjs removes stale ones`
)

for (const line of [...notes, ...failures]) console.log(`[doctor] ${line}`)
process.exit(failures.length === 0 ? 0 : 1)
