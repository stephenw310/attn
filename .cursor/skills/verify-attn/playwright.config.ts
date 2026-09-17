import { join } from 'node:path'
import { defineConfig } from '@playwright/test'

// Verification drives run against the production build in out/ with the same
// Electron fixture as the e2e suite, but from this directory, so `npm run e2e`
// and CI never pick them up.
const runId = process.env.ATTN_VERIFY_RUN
if (!runId) throw new Error('ATTN_VERIFY_RUN is unset. Run drives through scripts/drive.mjs.')

export default defineConfig({
  testDir: './drives',
  timeout: 60_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: join(__dirname, '../../../e2e/.artifacts/verify-attn', runId, 'results'),
  use: { trace: 'retain-on-failure' }
})
