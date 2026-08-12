#!/usr/bin/env node
// Launches the Playwright e2e suite, wrapping in xvfb-run on display-less
// Linux so `npm run e2e` behaves identically on dev machines, CI, and
// sandboxed agent containers. Extra CLI args pass through to Playwright.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const cli = require.resolve('@playwright/test/cli')
const visible = process.argv.includes('--visible')
const perf = process.argv.includes('--perf')
const playwrightArgs = process.argv.slice(2).filter((arg) => arg !== '--visible' && arg !== '--perf')
const cmd = [process.execPath, cli, 'test', ...playwrightArgs]
const env = {
  ...process.env,
  ...(visible ? { ATTN_E2E_VISIBLE: '1' } : {}),
  ...(perf ? { ATTN_E2E_PERF: '1' } : {})
}

let exec = cmd
if (process.platform === 'linux' && !process.env.DISPLAY) {
  const probe = spawnSync('xvfb-run', ['--help'], { stdio: 'ignore' })
  if (probe.error) {
    console.error(
      '[e2e] No DISPLAY and xvfb-run is missing — install xvfb (apt-get install xvfb) or set DISPLAY.'
    )
    process.exit(1)
  }
  exec = ['xvfb-run', '-a', '--server-args=-screen 0 1440x900x24', ...cmd]
}

const res = spawnSync(exec[0], exec.slice(1), { stdio: 'inherit', env })
if (res.error) console.error('[e2e] failed to launch test runner:', res.error)
process.exit(res.status ?? 1)
