#!/usr/bin/env node
import { readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { newestMtime } from './fs.mjs'

const DEFAULT_IDLE_MINUTES = 60

const args = process.argv.slice(2)
const flag = args.indexOf('--older-than')
const minutes = flag === -1 ? DEFAULT_IDLE_MINUTES : Number(args[flag + 1])
if (!Number.isFinite(minutes) || minutes < 0) {
  console.error('[cleanup] --older-than needs a non-negative number of minutes')
  process.exit(2)
}
const cutoff = Date.now() - minutes * 60_000

let removed = 0
let kept = 0
for (const name of readdirSync(tmpdir())) {
  if (!name.startsWith('attn-e2e-')) continue
  const path = join(tmpdir(), name)
  if (newestMtime(path).mtime > cutoff) {
    kept++
    continue
  }
  rmSync(path, { recursive: true, force: true, maxRetries: 3 })
  removed++
}
console.log(`[cleanup] removed ${removed} stale profiles, kept ${kept} written within ${minutes} minutes`)
