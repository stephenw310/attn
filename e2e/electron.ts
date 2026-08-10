import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  test as base,
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page
} from '@playwright/test'

// Each test boots the built app (out/main/index.js) with a throwaway userData
// dir: fresh SQLite store, no tokens, no oauth.config.json — so runs are
// hermetic and deterministic (signed-out mock-data mode) on any machine.

const ROOT = join(__dirname, '..')

interface Boot {
  app: ElectronApplication
  chunks: string[]
  userData: string
}

interface ElectronFixtures {
  boot: Boot
  app: ElectronApplication
  page: Page
  /** The isolated userData dir this test's app instance runs against. */
  userData: string
  /** Main-process stdout/stderr captured after launch (attached on failure). */
  mainLog: () => string
}

export const test = base.extend<ElectronFixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright's fixture API requires a destructuring pattern; this fixture has no dependencies
  boot: async ({}, use, testInfo) => {
    const userData = mkdtempSync(join(tmpdir(), 'attn-e2e-'))
    const args = [join(ROOT, 'out/main/index.js')]
    if (process.platform === 'linux') {
      // Container/CI realities: no SUID sandbox as root, tiny /dev/shm.
      if (process.getuid?.() === 0 || process.env.CI) args.push('--no-sandbox')
      args.push('--disable-dev-shm-usage')
    }
    const app = await electron.launch({
      args,
      env: { ...cleanEnv(), ATTN_TEST_USER_DATA: userData },
      cwd: ROOT
    })
    const chunks: string[] = []
    app.process().stdout?.on('data', (d: Buffer) => chunks.push(d.toString()))
    app.process().stderr?.on('data', (d: Buffer) => chunks.push(d.toString()))
    await use({ app, chunks, userData })
    await app.close().catch(() => {})
    if (testInfo.status !== testInfo.expectedStatus) {
      await testInfo.attach('main-process-log', { body: chunks.join(''), contentType: 'text/plain' })
    }
    rmSync(userData, { recursive: true, force: true, maxRetries: 3 })
  },

  app: async ({ boot }, use) => {
    await use(boot.app)
  },

  userData: async ({ boot }, use) => {
    await use(boot.userData)
  },

  mainLog: async ({ boot }, use) => {
    await use(() => boot.chunks.join(''))
  },

  page: async ({ app }, use) => {
    const page = await app.firstWindow()
    const rendererErrors: string[] = []
    page.on('console', (msg) => {
      if (msg.type() === 'error') rendererErrors.push(msg.text())
    })
    page.on('pageerror', (err) => rendererErrors.push(String(err)))
    await use(page)
    // Guardrail for every test: a clean run must leave zero renderer errors.
    expect(rendererErrors, 'renderer console/page errors').toEqual([])
  }
})

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v
  }
  // Never leak node-mode into the app under test.
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

export { expect }
