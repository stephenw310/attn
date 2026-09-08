import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
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
// hermetic and deterministic (signed-out onboarding or a seeded store) on any machine.

const ROOT = join(__dirname, '..')

interface Boot {
  app: ElectronApplication
  mainLog: () => string
  relaunch: (options?: {
    /** SIGKILL the app instead of quitting it: a real crash, not a clean exit. */
    kill?: boolean
  }) => Promise<{ app: ElectronApplication; page: Page }>
  userData: string
}

interface ElectronOptions {
  /** JSON fixture path, resolved relative to e2e/, used to seed the real SQLite store. */
  seed?: string
  /** Extra argv for the app under test, e.g. ['--hidden'] to drive an F16 login launch. */
  appArgs?: string[]
}

interface ElectronFixtures {
  boot: Boot
  app: ElectronApplication
  page: Page
  /** The isolated userData dir this test's app instance runs against. */
  userData: string
  /**
   * The complete main-process log: the app's teed main.log (covers boot lines
   * Playwright consumes before listeners attach) plus captured stdout/stderr
   * (covers native/Chromium output). Attached to failed tests.
   */
  mainLog: () => string
}

export const test = base.extend<ElectronFixtures & ElectronOptions>({
  seed: [undefined, { option: true }],
  appArgs: [undefined, { option: true }],

  boot: async ({ seed, appArgs }, use, testInfo) => {
    const userData = mkdtempSync(join(tmpdir(), 'attn-e2e-'))
    // Keep real Electron windows off the desktop during normal local runs. A
    // hidden BrowserWindow still renders, receives Playwright input, and can be
    // screenshotted; --visible is only an opt-in debugging aid in run-e2e.mjs.
    const hiddenArgs = process.env.ATTN_E2E_VISIBLE === '1' ? [] : ['--hidden']
    const args = [join(ROOT, 'out/main/index.js'), ...hiddenArgs, ...(appArgs ?? [])]
    if (process.platform === 'linux') {
      // Container/CI realities: no SUID sandbox as root, tiny /dev/shm.
      if (process.getuid?.() === 0 || process.env.CI) args.push('--no-sandbox')
      args.push('--disable-dev-shm-usage')
    }
    const chunks: string[] = []
    const rendererErrors: string[] = []
    // The mail fixtures deliberately embed remote assets on reserved `.test`
    // hosts (RFC 6761: never resolvable) to prove the sanitizer and the
    // sandboxed frame handle hostile HTML. Chromium logs the resulting fetch
    // failure, and which failure it is depends on the machine: a bare runner
    // reports ERR_NAME_NOT_RESOLVED, one behind a proxy reports a tunnel error
    // or nothing at all. That is the environment answering, not the app
    // misbehaving, so it must not decide whether a test passes. Scoped by URL —
    // a failed load from any other host is still a real error.
    const isFixtureHostUnreachable = (url: string): boolean => {
      try {
        return new URL(url).hostname.endsWith('.attn.test')
      } catch {
        return false
      }
    }
    const watchRenderer = (page: Page): void => {
      page.on('console', (msg) => {
        if (msg.type() !== 'error') return
        if (isFixtureHostUnreachable(msg.location().url)) return
        // A remote image cancelled by the T33 request filter logs
        // ERR_BLOCKED_BY_CLIENT from inside the mail frame. That is the
        // feature enforcing the block, not the app misbehaving; every other
        // failed load still fails the test.
        if (msg.text().includes('ERR_BLOCKED_BY_CLIENT')) return
        // A sender's `@import` refused by `style-src` is the policy doing its
        // job — that policy is the only thing standing between a kept <style>
        // and a fetch. Confined on three axes: the mail frame is the only
        // document it may come from, `style-src` the only directive, and a
        // remote sheet the only subject. Attn's own styles are bundled and
        // load from `file:` in the app document, so a violation naming one is
        // still a failure.
        if (
          msg.location().url === 'about:srcdoc' &&
          msg.text().includes('Content Security Policy') &&
          msg.text().includes('style-src') &&
          /'https?:\/\//.test(msg.text())
        )
          return
        rendererErrors.push(msg.text())
      })
      page.on('pageerror', (err) => rendererErrors.push(String(err)))
    }
    const launch = async (): Promise<ElectronApplication> => {
      const env: Record<string, string> = { ...cleanEnv(), ATTN_TEST_USER_DATA: userData }
      if (seed) env.ATTN_TEST_SEED = join(__dirname, seed)
      const launched = await electron.launch({ args, env, cwd: ROOT })
      launched.process().stdout?.on('data', (d: Buffer) => chunks.push(d.toString()))
      launched.process().stderr?.on('data', (d: Buffer) => chunks.push(d.toString()))
      try {
        // firstWindow has its own 30-second default that is independent of the
        // test timeout. Let suites with expensive deterministic setup (the
        // 10,000-thread performance seed) extend both waits together.
        const page = await launched.firstWindow({ timeout: testInfo.timeout })
        // Keep pre-F14 suites pinned to the original Dark baseline.
        // Theme coverage overrides this explicitly when it exercises System.
        await page.emulateMedia({ colorScheme: 'dark' })
        watchRenderer(page)
      } catch (err) {
        // A boot that dies before its first window (e.g. a failed seed) must
        // not leak the half-launched instance while the failure propagates.
        await launched.close().catch(() => {})
        throw err
      }
      return launched
    }
    const mainLog = (): string => {
      let teed = ''
      try {
        teed = readFileSync(join(userData, 'main.log'), 'utf8')
      } catch {
        // App may not have written anything yet.
      }
      return `${teed}${chunks.join('')}`
    }
    let app: ElectronApplication
    try {
      app = await launch()
    } catch (err) {
      // A boot failure reports as an opaque firstWindow() rejection — attach
      // the main log BEFORE deleting the dir so the app's own last words
      // (e.g. "[boot] failed: …") survive into the test report.
      await testInfo.attach('main-process-log', { body: mainLog(), contentType: 'text/plain' })
      // Never leak the temp dir when the app can't even start.
      rmSync(userData, { recursive: true, force: true, maxRetries: 3 })
      throw err
    }
    const boot: Boot = {
      app,
      mainLog,
      userData,
      relaunch: async (options) => {
        if (options?.kill) await kill(boot.app)
        else await boot.app.close()
        boot.app = await launch()
        return { app: boot.app, page: await boot.app.firstWindow() }
      }
    }
    await use(boot)
    await boot.app.close().catch(() => {})
    // The attach must cover failures the expect below is about to raise, so
    // check pending renderer errors too — not just the already-failed status.
    if (testInfo.status !== testInfo.expectedStatus || rendererErrors.length > 0) {
      await testInfo.attach('main-process-log', { body: mainLog(), contentType: 'text/plain' })
    }
    rmSync(userData, { recursive: true, force: true, maxRetries: 3 })
    expect(rendererErrors, 'renderer console/page errors across launches').toEqual([])
  },

  app: async ({ boot }, use) => {
    await use(boot.app)
  },

  userData: async ({ boot }, use) => {
    await use(boot.userData)
  },

  mainLog: async ({ boot }, use) => {
    await use(boot.mainLog)
  },

  page: async ({ app }, use) => {
    // Renderer console/page errors are collected and asserted once, by the
    // boot fixture, across every launch of the test's app — no second guard.
    await use(await app.firstWindow())
  }
})

/**
 * Crash the app the way a lost machine does (GAP-5): SIGKILL, no quit
 * handlers, no SQLite close. Playwright's own bookkeeping is closed
 * afterwards so the next launch starts from a clean fixture; the boot
 * fixture's log capture and renderer-error collection span both launches
 * either way, because they live in the fixture, not in the app.
 */
async function kill(app: ElectronApplication): Promise<void> {
  const child = app.process()
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  child.kill('SIGKILL')
  await exited
  await app.close().catch(() => {})
}

function cleanEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v
  }
  // Never leak node-mode into the app under test.
  delete env.ELECTRON_RUN_AS_NODE
  // Seeded mode is opt-in per spec, never inherited from the runner's shell.
  delete env.ATTN_TEST_SEED
  return env
}

export { expect }
