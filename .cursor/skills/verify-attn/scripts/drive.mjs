#!/usr/bin/env node
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL = join(dirname(fileURLToPath(import.meta.url)), '..')
const ROOT = join(SKILL, '../../..')
const args = process.argv.slice(2)
const skipDoctor = args.includes('--skip-doctor')
const passthrough = args.filter((arg) => arg !== '--skip-doctor')

if (!skipDoctor) {
  const doctor = spawnSync(process.execPath, [join(SKILL, 'scripts/doctor.mjs')], { stdio: 'inherit' })
  if (doctor.status !== 0) process.exit(doctor.status ?? 1)
}

const runId = process.env.ATTN_VERIFY_RUN ?? new Date().toISOString().replace(/[-:]|\..*$/g, '')
const evidence = join(ROOT, 'e2e/.artifacts/verify-attn', runId)
console.log(`[drive] run ${runId}`)

const result = spawnSync(
  process.execPath,
  [join(ROOT, 'scripts/run-e2e.mjs'), '--config', join(SKILL, 'playwright.config.ts'), ...passthrough],
  { stdio: 'inherit', cwd: ROOT, env: { ...process.env, ATTN_VERIFY_RUN: runId } }
)

if (existsSync(evidence)) {
  console.log(`[drive] evidence in ${relative(ROOT, evidence)}`)
  for (const file of walk(evidence)) console.log(`[drive]   ${relative(evidence, file)}`)
} else {
  console.log('[drive] no evidence written')
}
process.exit(result.status ?? 1)

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name)
    return entry.isDirectory() ? walk(path) : [path]
  })
}
