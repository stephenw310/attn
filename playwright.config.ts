import { defineConfig } from '@playwright/test'

// E2E runs against the production build (out/) — `npm run e2e` builds first.
// Workers stay at 1: each test boots its own Electron instance, and parallel
// GUI apps under one virtual display flake more than they save.
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  outputDir: './e2e/.results',
  use: { trace: 'retain-on-failure' }
})
