#!/usr/bin/env node
import { spawn } from 'node:child_process'
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import net from 'node:net'
import { tmpdir } from 'node:os'
import {
  dirname,
  extname,
  isAbsolute,
  join,
  delimiter as pathDelimiter,
  resolve as resolvePath
} from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * @typedef {{
 *   runId: string
 *   pid: number
 *   socket: string
 *   userData: string
 *   seed: string | null
 *   evidenceDir: string
 *   visible: boolean
 *   startedAt: string
 * }} RunFile
 *
 * @typedef {{ cmd: string, args?: Record<string, unknown> }} Request
 *
 * @typedef {{ ok: true, result: unknown } | {
 *   ok: false
 *   error: string
 *   hint: string
 * }} Reply
 *
 * @typedef {{ name: string, ok: boolean, detail: string }} DoctorCheck
 */

const SELF = fileURLToPath(import.meta.url)
const ROOT = join(dirname(SELF), '../../..')
const RUN_DIR = join(tmpdir(), 'attn-verify')
const HINT_LAUNCH = 'Run: control-attn launch --seed inbox'
const HINT_SNAPSHOT = 'Run snapshot to see available handles'
const RPC_TIMEOUT_MS = 60_000
const LAUNCH_WAIT_MS = 40_000
const ORPHAN_IDLE_MS = 60 * 60 * 1000

class CmdError extends Error {
  /**
   * @param {string} message
   * @param {string} hint
   */
  constructor(message, hint) {
    super(message)
    this.hint = hint
  }
}

/** Newest file under `dir`, recursively. A directory's own mtime ignores writes inside its files. */
function newestMtime(dir) {
  let newest = { path: dir, mtime: statSync(dir).mtimeMs }
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    const candidate = entry.isDirectory() ? newestMtime(path) : { path, mtime: statSync(path).mtimeMs }
    if (candidate.mtime > newest.mtime) newest = candidate
  }
  return newest
}

function tryUnlink(path) {
  try {
    unlinkSync(path)
  } catch {
    // Already gone.
  }
}

function fail(error, hint, extra) {
  const reply = extra ? { ok: false, error, hint, ...extra } : { ok: false, error, hint }
  process.stdout.write(`${JSON.stringify(reply)}\n`)
  process.exit(1)
}

function ok(result) {
  process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`)
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function which(bin) {
  return (process.env.PATH ?? '').split(pathDelimiter).some((dir) => existsSync(join(dir, bin)))
}

function runPathFor(runId) {
  return join(RUN_DIR, `${runId}.json`)
}

function socketPathFor(runId) {
  return join(RUN_DIR, `${runId}.sock`)
}

/** @param {string} path */
function readRunFile(path) {
  let raw
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new CmdError(`No run file at ${path}`, HINT_LAUNCH)
  }
  try {
    const run = JSON.parse(raw)
    if (!run.runId || !run.socket || !run.userData || !run.evidenceDir) {
      throw new Error('missing fields')
    }
    return /** @type {RunFile} */ (run)
  } catch {
    throw new CmdError(`Invalid run file ${path}`, HINT_LAUNCH)
  }
}

/** @param {RunFile} run */
function writeRunFile(run) {
  mkdirSync(dirname(runPathFor(run.runId)), { recursive: true })
  writeFileSync(runPathFor(run.runId), `${JSON.stringify(run, null, 2)}\n`)
}

function listRunFiles() {
  if (!existsSync(RUN_DIR)) return []
  return readdirSync(RUN_DIR)
    .filter((name) => name.endsWith('.json'))
    .map((name) => join(RUN_DIR, name))
}

function newestRunFile() {
  let newest = /** @type {{ path: string, mtime: number } | null} */ (null)
  for (const path of listRunFiles()) {
    const mtime = statSync(path).mtimeMs
    if (!newest || mtime > newest.mtime) newest = { path, mtime }
  }
  return newest ? readRunFile(newest.path) : null
}

/** @param {string | undefined} explicit */
function resolveRun(explicit) {
  const id = explicit ?? process.env.ATTN_VERIFY_RUN
  if (id) return readRunFile(runPathFor(id))
  const newest = newestRunFile()
  if (!newest) throw new CmdError('No verify-attn run is active', HINT_LAUNCH)
  return newest
}

/** @param {string | undefined} value */
function resolveSeed(value) {
  if (!value) return null
  const path = value.includes('/')
    ? isAbsolute(value)
      ? value
      : join(ROOT, value)
    : join(ROOT, 'e2e/fixtures', `seed-${value}.json`)
  const abs = resolvePath(path)
  if (!existsSync(abs)) {
    throw new CmdError(`Seed not found: ${abs}`, 'Pass a fixture name or a path containing /')
  }
  return abs
}

function nodeMeetsMinimum() {
  const [major, minor] = process.versions.node.split('.').map(Number)
  return major > 22 || (major === 22 && minor >= 12)
}

function electronBinary() {
  const pathFile = join(ROOT, 'node_modules/electron/path.txt')
  if (!existsSync(pathFile)) return null
  return join(ROOT, 'node_modules/electron/dist', readFileSync(pathFile, 'utf8').trim())
}

function sqliteBinary() {
  const candidates = [
    join(ROOT, `node_modules/better-sqlite3/prebuilds/${process.platform}-${process.arch}.node`),
    join(ROOT, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node')
  ]
  return candidates.find((candidate) => existsSync(candidate)) ?? null
}

function preflightChecks() {
  /** @type {DoctorCheck[]} */
  const checks = []
  const nodeOk = nodeMeetsMinimum()
  checks.push({
    name: 'node',
    ok: nodeOk,
    detail: `node ${process.versions.node} (need >= 22.12)`
  })

  const built = ['out/main/index.js', 'out/preload/index.js', 'out/renderer/index.html']
  const missing = built.filter((file) => !existsSync(join(ROOT, file)))
  const buildOk = missing.length === 0
  checks.push({
    name: 'build',
    ok: buildOk,
    detail: buildOk ? 'out/main, out/preload, and out/renderer exist' : `missing ${missing.join(', ')}`
  })

  if (buildOk) {
    const builtAt = statSync(join(ROOT, 'out/main/index.js')).mtimeMs
    const newest = newestMtime(join(ROOT, 'src'))
    const fresh = newest.mtime <= builtAt
    checks.push({
      name: 'out-freshness',
      ok: fresh,
      detail: fresh
        ? 'out/ is newer than every file in src/'
        : `${newest.path} changed after the build. Run npm run build`
    })
  }

  const binary = electronBinary()
  checks.push({
    name: 'electron',
    ok: Boolean(binary && existsSync(binary)),
    detail: binary ?? 'node_modules/electron/path.txt missing'
  })

  const sqlite = sqliteBinary()
  checks.push({
    name: 'better-sqlite3',
    ok: sqlite !== null,
    detail: sqlite ?? 'better-sqlite3 binary missing. Run npm run toolchain'
  })

  if (process.platform === 'linux' && !process.env.DISPLAY) {
    const xvfb = which('xvfb-run')
    checks.push({
      name: 'display',
      ok: true,
      detail: xvfb
        ? 'DISPLAY is unset. xvfb-run is on PATH. This CLI launches Electron directly, so wrap the launch command with xvfb-run or set DISPLAY. run-e2e style wrapping is unsupported.'
        : 'DISPLAY is unset and xvfb-run is not on PATH. Set DISPLAY or install xvfb-run. This CLI launches Electron directly.'
    })
  }

  return checks
}

/** @param {RunFile} run */
async function liveChecks(run) {
  /** @type {DoctorCheck[]} */
  const checks = []
  const alive = pidAlive(run.pid)
  checks.push({
    name: 'pid',
    ok: alive,
    detail: alive ? `pid ${run.pid} is alive` : `pid ${run.pid} is not running`
  })

  let ping = /** @type {Reply | null} */ (null)
  try {
    ping = await rpc(run.socket, 'ping', {})
  } catch (err) {
    ping = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      hint: 'Run: control-attn doctor'
    }
  }
  checks.push({
    name: 'socket',
    ok: Boolean(ping.ok),
    detail: ping.ok ? 'socket answered ping' : ping.error
  })

  if (!ping.ok) {
    checks.push({
      name: 'userData',
      ok: false,
      detail: 'skipped. socket did not answer'
    })
    checks.push({
      name: 'main.log',
      ok: false,
      detail: 'skipped. socket did not answer'
    })
    checks.push({
      name: 'renderer-errors',
      ok: false,
      detail: 'skipped. socket did not answer'
    })
    return checks
  }

  let info = /** @type {{ userData?: string, rendererErrors?: number, url?: string } | null} */ (null)
  try {
    const reply = await rpc(run.socket, 'info', {})
    info = reply.ok ? /** @type {{ userData?: string, rendererErrors?: number }} */ (reply.result) : null
    if (!reply.ok) {
      checks.push({ name: 'userData', ok: false, detail: reply.error })
    }
  } catch (err) {
    checks.push({
      name: 'userData',
      ok: false,
      detail: err instanceof Error ? err.message : String(err)
    })
  }

  if (info) {
    const match = info.userData === run.userData
    checks.push({
      name: 'userData',
      ok: match,
      detail: match
        ? (info.userData ?? run.userData)
        : `info.userData ${info.userData} !== run file ${run.userData}`
    })
    const errorCount = info.rendererErrors ?? 0
    checks.push({
      name: 'renderer-errors',
      ok: errorCount === 0,
      detail: `${errorCount} renderer error${errorCount === 1 ? '' : 's'}`
    })
  }

  let log = ''
  try {
    log = readFileSync(join(run.userData, 'main.log'), 'utf8')
  } catch {
    log = ''
  }
  const dbOpen = /\[db\] open at .*attn-verify-.*attn\.db \(schema v\d+\)/.test(log)
  checks.push({
    name: 'main.log',
    ok: dbOpen,
    detail: dbOpen
      ? 'store opened under the throwaway profile'
      : 'main.log does not show [db] open at ...attn-verify-...attn.db (schema vN)'
  })
  return checks
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * @param {string} socketPath
 * @param {string} cmd
 * @param {Record<string, unknown>} args
 * @param {number} [timeoutMs]
 * @returns {Promise<Reply>}
 */
function rpc(socketPath, cmd, args, timeoutMs = RPC_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath)
    let buf = ''
    let settled = false
    const settle = (fn) => {
      if (settled) return
      settled = true
      fn()
    }
    socket.setTimeout(timeoutMs)
    socket.on('timeout', () => {
      socket.destroy()
      settle(() => reject(new CmdError('Timed out waiting for the daemon', 'Run: control-attn doctor')))
    })
    socket.on('error', (err) => {
      settle(() => reject(new CmdError(err instanceof Error ? err.message : String(err), HINT_LAUNCH)))
    })
    socket.on('data', (chunk) => {
      buf += chunk.toString()
    })
    socket.on('end', () => {
      settle(() => {
        try {
          resolve(/** @type {Reply} */ (JSON.parse(buf.trim())))
        } catch {
          reject(new CmdError(`Bad daemon reply: ${buf}`, 'Read daemon.log in the evidence dir'))
        }
      })
    })
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ cmd, args })}\n`)
    })
  })
}

function cleanEnv() {
  /** @type {Record<string, string>} */
  const env = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined) env[k] = v
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ATTN_TEST_SEED
  return env
}

function isFixtureHostUnreachable(url) {
  try {
    return new URL(url).hostname.endsWith('.attn.test')
  } catch {
    return false
  }
}

/**
 * @param {string} runPath
 */
async function serve(runPath) {
  const { _electron: electron } = await import('@playwright/test')
  const run = readRunFile(runPath)
  run.pid = process.pid
  writeRunFile(run)
  mkdirSync(run.evidenceDir, { recursive: true })

  const rendererLog = join(run.evidenceDir, 'renderer-errors.log')
  const stdioLog = join(run.evidenceDir, 'main-stdio.log')
  writeFileSync(stdioLog, '')
  let rendererErrorCount = 0
  const startedAt = Date.now()

  /** @type {import('@playwright/test').ElectronApplication} */
  let app
  /** @type {import('@playwright/test').Page} */
  let page

  let shuttingDown = false
  /** Converges on no app, no profile, no socket, no run file. Safe to call from any exit path. */
  const shutdown = async (code, reason) => {
    if (shuttingDown) return
    shuttingDown = true
    if (reason) appendFileSync(join(run.evidenceDir, 'daemon.log'), `${reason}\n`)
    if (app) await app.close().catch(() => {})
    rmSync(run.userData, { recursive: true, force: true, maxRetries: 3 })
    tryUnlink(run.socket)
    tryUnlink(runPath)
    process.exit(code)
  }
  process.on('SIGTERM', () => shutdown(0, 'SIGTERM'))
  process.on('SIGINT', () => shutdown(0, 'SIGINT'))

  const failBoot = (err) => {
    const message = err instanceof Error ? (err.stack ?? err.message) : String(err)
    return shutdown(1, message)
  }

  const args = [join(ROOT, 'out/main/index.js'), ...(run.visible ? [] : ['--hidden'])]
  if (process.platform === 'linux') {
    if (process.getuid?.() === 0 || process.env.CI) args.push('--no-sandbox')
    args.push('--disable-dev-shm-usage')
  }
  const env = { ...cleanEnv(), ATTN_TEST_USER_DATA: run.userData }
  if (run.seed) env.ATTN_TEST_SEED = run.seed

  try {
    app = await electron.launch({ args, env, cwd: ROOT })
    const child = app.process()
    child.stdout?.on('data', (d) => appendFileSync(stdioLog, d.toString()))
    child.stderr?.on('data', (d) => appendFileSync(stdioLog, d.toString()))
    page = await app.firstWindow({ timeout: 30_000 })
    await page.emulateMedia({ colorScheme: 'dark' })
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return
      if (isFixtureHostUnreachable(msg.location().url)) return
      if (msg.text().includes('ERR_BLOCKED_BY_CLIENT')) return
      rendererErrorCount += 1
      appendFileSync(rendererLog, `${msg.text()}\n`)
    })
    page.on('pageerror', (err) => {
      rendererErrorCount += 1
      appendFileSync(rendererLog, `${String(err)}\n`)
    })
    app.on('close', () => shutdown(1, 'Electron exited on its own'))
  } catch (err) {
    await failBoot(err)
    return
  }

  const replyError = (err) => {
    const error = err instanceof Error ? err.message : String(err)
    const hint = err instanceof CmdError ? err.hint : 'Run: control-attn doctor'
    return { ok: false, error, hint }
  }

  const handlers = {
    ping: async () => ({ pid: process.pid, uptimeMs: Date.now() - startedAt }),
    info: async () => ({
      userData: await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData')),
      rendererErrors: rendererErrorCount,
      url: page.url()
    }),
    press: async (/** @type {Record<string, unknown>} */ args) => {
      if (typeof args.key !== 'string' || args.key.length === 0) {
        throw new CmdError('press needs a key', 'Run: control-attn press j')
      }
      await page.keyboard.press(args.key)
      return {}
    },
    type: async (/** @type {Record<string, unknown>} */ args) => {
      if (typeof args.text !== 'string') {
        throw new CmdError('type needs text', 'Run: control-attn type hello')
      }
      await page.keyboard.type(args.text)
      return {}
    },
    click: async (/** @type {Record<string, unknown>} */ args) => {
      const testid = typeof args.testid === 'string' ? args.testid : undefined
      const role = typeof args.role === 'string' ? args.role : undefined
      const name = typeof args.name === 'string' ? args.name : undefined
      const text = typeof args.text === 'string' ? args.text : undefined
      const nth = typeof args.nth === 'number' ? args.nth : undefined
      if (!testid && !role) {
        throw new CmdError('click needs a testid or --role and --name', 'Run: control-attn click thread-row')
      }
      let locator = testid
        ? page.getByTestId(testid)
        : page.getByRole(/** @type {Parameters<typeof page.getByRole>[0]} */ (role), name ? { name } : {})
      if (text) locator = locator.filter({ hasText: text })
      if (nth !== undefined) locator = locator.nth(nth)
      const count = await locator.count()
      if (count === 0) throw new CmdError('No matching element', HINT_SNAPSHOT)
      await locator.click({ timeout: 5000 })
      return { count: await locator.count() }
    },
    fill: async (/** @type {Record<string, unknown>} */ args) => {
      if (typeof args.testid !== 'string' || typeof args.text !== 'string') {
        throw new CmdError('fill needs a testid and text', 'Run: control-attn fill search-input query')
      }
      let target = page.getByTestId(args.testid)
      if ((await target.count()) === 0) throw new CmdError('No matching element', HINT_SNAPSHOT)
      const info = await target.evaluate(
        (el) => ({ tag: el.tagName, editable: el instanceof HTMLElement && el.isContentEditable }),
        undefined,
        { timeout: 5000 }
      )
      if (info.tag !== 'INPUT' && info.tag !== 'TEXTAREA' && !info.editable) {
        target = target.locator('input, textarea, [contenteditable="true"]').first()
      }
      await target.fill(args.text, { timeout: 5000 })
      return {}
    },
    eval: async (/** @type {Record<string, unknown>} */ args) => {
      if (typeof args.js !== 'string') {
        throw new CmdError('eval needs a JS expression', 'Run: control-attn eval "1 + 1"')
      }
      return await page.evaluate(args.js)
    },
    seam: async (/** @type {Record<string, unknown>} */ args) => {
      if (typeof args.name !== 'string' || args.name.length === 0) {
        throw new CmdError('seam needs a name', 'Run: control-attn seam setUndoSendDelay 0 --fire')
      }
      const channel = args.name.startsWith('attn:test:') ? args.name : `attn:test:${args.name}`
      const seamArgs = Array.isArray(args.args) ? args.args : []
      if (args.fire) {
        await app.evaluate(
          ({ ipcMain }, input) => {
            ipcMain.emit(input.channel, {}, ...input.args)
          },
          { channel, args: seamArgs }
        )
        return {}
      }
      return await app.evaluate(
        ({ ipcMain }, input) =>
          new Promise((resolve) => ipcMain.emit(input.channel, {}, ...input.args, resolve)),
        { channel, args: seamArgs }
      )
    },
    snapshot: async (/** @type {Record<string, unknown>} */ args) => {
      const testid = typeof args.testid === 'string' ? args.testid : undefined
      const locator = testid ? page.getByTestId(testid) : page.locator('body')
      if ((await locator.count()) === 0) throw new CmdError('No matching element', HINT_SNAPSHOT)
      return { aria: await locator.ariaSnapshot({ timeout: 5000 }) }
    },
    screenshot: async (/** @type {Record<string, unknown>} */ args) => {
      if (typeof args.name !== 'string' || args.name.length === 0) {
        throw new CmdError('screenshot needs a name', 'Run: control-attn screenshot 01-inbox-list')
      }
      const file = extname(args.name) === '.png' ? args.name : `${args.name}.png`
      const path = join(run.evidenceDir, file)
      await page.screenshot({ path })
      return { path }
    },
    log: async (/** @type {Record<string, unknown>} */ args) => {
      const n = typeof args.lines === 'number' && args.lines > 0 ? args.lines : 40
      let text = ''
      try {
        text = readFileSync(join(run.userData, 'main.log'), 'utf8')
      } catch {
        text = ''
      }
      const lines = text === '' ? [] : text.replace(/\n$/, '').split('\n')
      return { lines: lines.slice(-n) }
    },
    wait: async (/** @type {Record<string, unknown>} */ args) => {
      if (typeof args.testid !== 'string') {
        throw new CmdError('wait needs a testid', 'Run: control-attn wait thread-list')
      }
      const state =
        typeof args.state === 'string'
          ? /** @type {'attached' | 'detached' | 'visible' | 'hidden'} */ (args.state)
          : 'visible'
      const timeout = typeof args.timeout === 'number' ? args.timeout : 5000
      await page.getByTestId(args.testid).waitFor({ state, timeout })
      return {}
    },
    close: async () => ({})
  }

  tryUnlink(run.socket)

  const server = net.createServer((socket) => {
    let buf = ''
    socket.on('data', (chunk) => {
      buf += chunk.toString()
      if (!buf.includes('\n')) return
      const line = buf.slice(0, buf.indexOf('\n')).trim()
      buf = ''
      let request = /** @type {Request} */ ({ cmd: '' })
      try {
        request = JSON.parse(line)
      } catch (err) {
        socket.end(
          `${JSON.stringify({
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            hint: 'Send one JSON object per line'
          })}\n`
        )
        return
      }
      const cmd = request.cmd
      const handler = handlers[/** @type {keyof typeof handlers} */ (cmd)]
      const finish = async () => {
        /** @type {Reply} */
        let reply
        if (!handler) {
          reply = { ok: false, error: `Unknown daemon command ${cmd}`, hint: 'Run: control-attn --help' }
        } else {
          try {
            reply = { ok: true, result: await handler(request.args ?? {}) }
          } catch (err) {
            reply = replyError(err)
          }
        }
        await new Promise((resolve) => {
          socket.end(`${JSON.stringify(reply)}\n`, resolve)
        })
        if (cmd !== 'close' || !reply.ok) return
        await new Promise((resolve) => server.close(resolve))
        await shutdown(0)
      }
      finish().catch((err) => {
        socket.end(`${JSON.stringify(replyError(err))}\n`)
      })
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(run.socket, resolve)
  })
}

async function cmdLaunch(opts) {
  const checks = preflightChecks()
  if (checks.some((check) => !check.ok)) {
    const failed = checks.find((check) => !check.ok)
    fail('Pre-flight doctor failed', failed?.detail ?? 'Run npm run build', { result: { checks } })
  }

  const seed = resolveSeed(opts.seed)
  const runId = new Date().toISOString().replace(/[-:]|\..*$/g, '')
  const userData = mkdtempSync(join(tmpdir(), 'attn-verify-'))
  const evidenceDir = join(ROOT, 'e2e/.artifacts/verify-attn', runId)
  mkdirSync(evidenceDir, { recursive: true })
  mkdirSync(RUN_DIR, { recursive: true })

  /** @type {RunFile} */
  const run = {
    runId,
    pid: 0,
    socket: socketPathFor(runId),
    userData,
    seed,
    evidenceDir,
    visible: Boolean(opts.visible),
    startedAt: new Date().toISOString()
  }
  writeRunFile(run)

  const logPath = join(evidenceDir, 'daemon.log')
  const outFd = openSync(logPath, 'w')
  const errFd = openSync(logPath, 'a')
  const child = spawn(process.execPath, [SELF, '__serve', runPathFor(runId)], {
    detached: true,
    stdio: ['ignore', outFd, errFd],
    cwd: ROOT
  })
  closeSync(outFd)
  closeSync(errFd)
  if (!child.pid) {
    rmSync(userData, { recursive: true, force: true, maxRetries: 3 })
    tryUnlink(runPathFor(runId))
    throw new CmdError('Failed to spawn the daemon', 'Read daemon.log in the evidence dir')
  }
  run.pid = child.pid
  writeRunFile(run)
  child.unref()

  const deadline = Date.now() + LAUNCH_WAIT_MS
  while (Date.now() < deadline) {
    if (!pidAlive(run.pid)) {
      let log = ''
      try {
        log = readFileSync(logPath, 'utf8').trim()
      } catch {
        log = ''
      }
      throw new CmdError(log || 'Daemon exited before it answered ping', `Read ${logPath}`)
    }
    try {
      const reply = await rpc(run.socket, 'ping', {}, 1000)
      if (reply.ok) {
        process.stderr.write(`ATTN_VERIFY_RUN=${runId}\n`)
        return { runId, userData, evidenceDir }
      }
    } catch {
      // Socket is not listening yet.
    }
    await sleep(200)
  }
  throw new CmdError('Daemon did not answer ping within 40s', `Read ${logPath}`)
}

async function cmdDoctor(explicitRun) {
  const checks = preflightChecks()
  const targeted = explicitRun ?? process.env.ATTN_VERIFY_RUN
  /** @type {RunFile | undefined} */
  let run
  if (targeted) {
    run = resolveRun(targeted)
  } else {
    run = newestRunFile() ?? undefined
  }
  if (run) checks.push(...(await liveChecks(run)))
  const okAll = checks.every((check) => check.ok)
  return {
    ok: okAll,
    result: run
      ? {
          checks,
          run: { runId: run.runId, pid: run.pid, userData: run.userData, evidenceDir: run.evidenceDir }
        }
      : { checks }
  }
}

/**
 * @typedef {{ action: string, runId?: string, close?: { socket: string, pid: number }, remove: string[] }} CleanupAction
 */

async function cmdCleanup(opts) {
  /** @type {CleanupAction[]} */
  const actions = []
  const referenced = new Set()
  for (const path of listRunFiles()) {
    let run
    try {
      run = readRunFile(path)
    } catch {
      actions.push({ action: 'remove-invalid-run-file', remove: [path] })
      continue
    }
    referenced.add(run.userData)
    const files = [run.userData, run.socket, path]
    if (!pidAlive(run.pid)) {
      actions.push({ action: 'remove-dead-run', runId: run.runId, remove: files })
    } else if (opts.all) {
      actions.push({
        action: 'close-live-run',
        runId: run.runId,
        close: { socket: run.socket, pid: run.pid },
        remove: files
      })
    }
  }

  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith('attn-verify-')) continue
    const path = join(tmpdir(), name)
    if (referenced.has(path)) continue
    if (Date.now() - newestMtime(path).mtime < ORPHAN_IDLE_MS) continue
    actions.push({ action: 'remove-orphan-profile', remove: [path] })
  }

  if (opts.dryRun) return { dryRun: true, actions }

  for (const action of actions) {
    if (action.close) await closeDaemon(action.close)
    for (const path of action.remove) rmSync(path, { recursive: true, force: true, maxRetries: 3 })
  }
  return { dryRun: false, actions }
}

/** Ask the daemon to close, fall back to SIGTERM, and wait for it to exit so its own cleanup runs first. */
async function closeDaemon({ socket, pid }) {
  let asked = false
  try {
    asked = (await rpc(socket, 'close', {}, 10_000)).ok
  } catch {
    asked = false
  }
  if (!asked) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      return
    }
  }
  const deadline = Date.now() + 10_000
  while (pidAlive(pid) && Date.now() < deadline) await sleep(100)
}

const USAGE = `control-attn.mjs <command> [args]

Remote-control one running copy of the built Attn app.
Every command is a fresh process. launch starts a detached daemon.

Global flags
  --run <id>   Target a run. Else ATTN_VERIFY_RUN, else the newest run file.
  --json       Print JSON even for snapshot and log.

Commands
  launch [--seed <name|path>] [--visible]
    Boot out/main/index.js against a throwaway profile.
    Example: node .cursor/skills/verify-attn/control-attn.mjs launch --seed inbox

  doctor
    Read-only pre-flight, plus live checks when a run is targeted.
    Example: node .cursor/skills/verify-attn/control-attn.mjs doctor

  press <key>
    Example: node .cursor/skills/verify-attn/control-attn.mjs press j

  type <text>
    Example: node .cursor/skills/verify-attn/control-attn.mjs type hello

  click <testid> [--text t] [--nth n]
  click --role <role> --name <name> [--text t] [--nth n]
    Example: node .cursor/skills/verify-attn/control-attn.mjs click thread-row --nth 2

  fill <testid> <text>
    Example: node .cursor/skills/verify-attn/control-attn.mjs fill command-palette-input "Go to Sent"

  eval <js>
    Example: node .cursor/skills/verify-attn/control-attn.mjs eval "window.attn.mail.getUnreadCount()"

  seam <name> [json-args...] [--fire]
    Example: node .cursor/skills/verify-attn/control-attn.mjs seam setUndoSendDelay 0 --fire

  snapshot [--testid id]
    Prints ARIA text. Example: node .cursor/skills/verify-attn/control-attn.mjs snapshot --testid conversation-subject

  screenshot <name>
    Example: node .cursor/skills/verify-attn/control-attn.mjs screenshot 01-inbox-list

  log [--lines n]
    Prints the last lines of the profile main.log.
    Example: node .cursor/skills/verify-attn/control-attn.mjs log --lines 40

  wait <testid> [--state s] [--timeout ms]
    Example: node .cursor/skills/verify-attn/control-attn.mjs wait conversation-view

  info
    Example: node .cursor/skills/verify-attn/control-attn.mjs info

  close
    Quit the app and delete the profile. Evidence stays.
    Example: node .cursor/skills/verify-attn/control-attn.mjs close

  cleanup [--dry-run] [--all]
    Remove dead runs. --all also closes live runs. Never touches e2e/.artifacts.
    Example: node .cursor/skills/verify-attn/control-attn.mjs cleanup --dry-run

  help
    Example: node .cursor/skills/verify-attn/control-attn.mjs help
`

/**
 * @param {string[]} argv
 */
function parseArgv(argv) {
  /** @type {Record<string, string>} */
  const named = {}
  const flags = {
    json: false,
    visible: false,
    fire: false,
    dryRun: false,
    all: false
  }
  const positionals = []
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--json') flags.json = true
    else if (arg === '--visible') flags.visible = true
    else if (arg === '--fire') flags.fire = true
    else if (arg === '--dry-run') flags.dryRun = true
    else if (arg === '--all') flags.all = true
    else if (arg === '--help' || arg === '-h') positionals.push('help')
    else if (
      arg === '--run' ||
      arg === '--seed' ||
      arg === '--text' ||
      arg === '--nth' ||
      arg === '--role' ||
      arg === '--name' ||
      arg === '--testid' ||
      arg === '--state' ||
      arg === '--timeout' ||
      arg === '--lines'
    ) {
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) {
        throw new CmdError(`${arg} needs a value`, 'Run: control-attn --help')
      }
      named[arg.slice(2)] = value
      i += 1
    } else if (arg.startsWith('--')) {
      throw new CmdError(`Unknown flag ${arg}`, 'Run: control-attn --help')
    } else {
      positionals.push(arg)
    }
  }
  return { cmd: positionals[0], rest: positionals.slice(1), flags, named }
}

function parseIntFlag(name, value) {
  if (value === undefined) return undefined
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) {
    throw new CmdError(`${name} must be a non-negative integer`, 'Run: control-attn --help')
  }
  return n
}

function parseSeamArg(raw) {
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function printCommandReply(reply, raw, json) {
  if (reply.ok && raw !== undefined && !json) {
    process.stdout.write(raw.endsWith('\n') ? raw : `${raw}\n`)
  } else {
    process.stdout.write(`${JSON.stringify(reply)}\n`)
  }
  process.exit(reply.ok ? 0 : 1)
}

async function send(cmd, args, explicitRun) {
  const run = resolveRun(explicitRun)
  return await rpc(run.socket, cmd, args)
}

async function main() {
  const argv = process.argv.slice(2)
  if (argv[0] === '__serve') {
    if (!argv[1]) fail('__serve needs a run file', HINT_LAUNCH)
    await serve(argv[1])
    return
  }

  let parsed
  try {
    parsed = parseArgv(argv)
  } catch (err) {
    const hint = err instanceof CmdError ? err.hint : 'Run: control-attn --help'
    fail(err instanceof Error ? err.message : String(err), hint)
    return
  }

  const { cmd, rest, flags, named } = parsed
  if (!cmd || cmd === 'help') {
    process.stdout.write(USAGE)
    process.exit(0)
  }

  try {
    if (cmd === 'launch') {
      const result = await cmdLaunch({ seed: named.seed, visible: flags.visible })
      ok(result)
      return
    }
    if (cmd === 'doctor') {
      const report = await cmdDoctor(named.run)
      process.stdout.write(`${JSON.stringify(report)}\n`)
      process.exit(report.ok ? 0 : 1)
    }
    if (cmd === 'cleanup') {
      const result = await cmdCleanup({ dryRun: flags.dryRun, all: flags.all })
      ok(result)
      return
    }
    if (cmd === 'press') {
      if (!rest[0]) throw new CmdError('press needs a key', 'Run: control-attn press j')
      printCommandReply(await send('press', { key: rest[0] }, named.run), undefined, flags.json)
    }
    if (cmd === 'type') {
      if (rest.length === 0) throw new CmdError('type needs text', 'Run: control-attn type hello')
      printCommandReply(await send('type', { text: rest.join(' ') }, named.run), undefined, flags.json)
    }
    if (cmd === 'click') {
      const nth = parseIntFlag('nth', named.nth)
      const args = {
        testid: rest[0],
        text: named.text,
        nth,
        role: named.role,
        name: named.name
      }
      printCommandReply(await send('click', args, named.run), undefined, flags.json)
    }
    if (cmd === 'fill') {
      if (!rest[0] || rest[1] === undefined) {
        throw new CmdError('fill needs a testid and text', 'Run: control-attn fill search-input query')
      }
      printCommandReply(
        await send('fill', { testid: rest[0], text: rest.slice(1).join(' ') }, named.run),
        undefined,
        flags.json
      )
    }
    if (cmd === 'eval') {
      if (rest.length === 0)
        throw new CmdError('eval needs a JS expression', 'Run: control-attn eval "1 + 1"')
      printCommandReply(await send('eval', { js: rest.join(' ') }, named.run), undefined, flags.json)
    }
    if (cmd === 'seam') {
      if (!rest[0]) {
        throw new CmdError('seam needs a name', 'Run: control-attn seam setUndoSendDelay 0 --fire')
      }
      printCommandReply(
        await send(
          'seam',
          { name: rest[0], args: rest.slice(1).map(parseSeamArg), fire: flags.fire },
          named.run
        ),
        undefined,
        flags.json
      )
    }
    if (cmd === 'snapshot') {
      const reply = await send('snapshot', { testid: named.testid }, named.run)
      const aria = reply.ok ? /** @type {{ aria: string }} */ (reply.result).aria : undefined
      printCommandReply(reply, aria, flags.json)
    }
    if (cmd === 'screenshot') {
      if (!rest[0]) {
        throw new CmdError('screenshot needs a name', 'Run: control-attn screenshot 01-inbox-list')
      }
      printCommandReply(await send('screenshot', { name: rest[0] }, named.run), undefined, flags.json)
    }
    if (cmd === 'log') {
      const lines = parseIntFlag('lines', named.lines)
      const reply = await send('log', { lines }, named.run)
      const raw = reply.ok ? /** @type {{ lines: string[] }} */ (reply.result).lines.join('\n') : undefined
      printCommandReply(reply, raw === undefined ? undefined : `${raw}\n`, flags.json)
    }
    if (cmd === 'wait') {
      if (!rest[0]) throw new CmdError('wait needs a testid', 'Run: control-attn wait thread-list')
      const timeout = named.timeout === undefined ? undefined : Number(named.timeout)
      if (named.timeout !== undefined && !Number.isFinite(timeout)) {
        throw new CmdError('timeout must be a number of milliseconds', 'Run: control-attn wait thread-list')
      }
      printCommandReply(
        await send('wait', { testid: rest[0], state: named.state, timeout }, named.run),
        undefined,
        flags.json
      )
    }
    if (cmd === 'info') {
      printCommandReply(await send('info', {}, named.run), undefined, flags.json)
    }
    if (cmd === 'close') {
      printCommandReply(await send('close', {}, named.run), undefined, flags.json)
    }
    throw new CmdError(`Unknown command ${cmd}`, 'Run: control-attn --help')
  } catch (err) {
    const hint = err instanceof CmdError ? err.hint : 'Run: control-attn --help'
    fail(err instanceof Error ? err.message : String(err), hint)
  }
}

main()
