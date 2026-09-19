import { defineConfig } from '@playwright/test'

// E2E runs against the production build (out/) — `npm run e2e` builds first.
// Keep one Electron worker per runner: each test boots its own app, and
// parallel GUI apps under one virtual display flake more than they save.
// fullyParallel lets Playwright distribute individual tests across CI shards
// instead of assigning whole files, which balances test counts across shards.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: true,
  workers: 1,
  forbidOnly: !!process.env.CI,
  grepInvert: process.env.ATTN_E2E_PERF === '1' ? undefined : /@perf/,
  retries: process.env.CI ? 1 : 0,
  // A retry that passes still reports the job green, so CI also writes a JSON
  // report into the directory it already uploads; `scripts/report-flaky.mjs`
  // reads it and prints the retried tests into the job log. Local runs keep the
  // plain list reporter and write no report file.
  reporter: process.env.CI
    ? [['list'], ['github'], ['json', { outputFile: './e2e/.results/results.json' }]]
    : [['list']],
  outputDir: './e2e/.results',
  use: { trace: 'retain-on-failure' }
})
