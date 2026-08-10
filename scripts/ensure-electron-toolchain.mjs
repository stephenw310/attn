#!/usr/bin/env node
// Ensures the Electron binary exists and native modules actually load inside
// Electron, proving it with an in-Electron better-sqlite3 query. Runs as
// postinstall and from the Claude session-start hook. Idempotent.
//
// Normal case: better-sqlite3 v13 ships Node-API prebuilds, so no compile is
// needed and the smoke test passes immediately (this is why postinstall no
// longer force-rebuilds). When the smoke fails (future non-N-API dep, ABI
// break, missing prebuild for a platform), the repair ladder is:
//   1. electron-rebuild (works on open networks)
//   2. + locally assembled Electron headers (see assembleHeaders) for
//      sandboxed networks where Electron's headers host is blocked but
//      github.com and nodejs.org are reachable — e.g. Claude web containers.
// The Electron binary download has its own fallback: seeding the
// @electron/get cache from GitHub releases with curl.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const CACHE = join(homedir(), '.cache', 'attn-toolchain')
const log = (m) => console.log(`[toolchain] ${m}`)
const fail = (m) => {
  console.error(`[toolchain] FAILED: ${m}`)
  process.exit(1)
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', cwd: ROOT, ...opts })
  return r.status === 0
}

function capture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', cwd: ROOT, ...opts })
  return r.status === 0 ? r.stdout.trim() : null
}

const electronVersion = JSON.parse(
  readFileSync(join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8')
).version

function electronBin() {
  const dist = join(ROOT, 'node_modules', 'electron', 'dist')
  const bin =
    process.platform === 'darwin'
      ? join(dist, 'Electron.app', 'Contents', 'MacOS', 'Electron')
      : join(dist, process.platform === 'win32' ? 'electron.exe' : 'electron')
  return existsSync(bin) ? bin : null
}

function inElectron(code) {
  const bin = electronBin()
  if (!bin) return null
  return capture(bin, ['-e', code], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
}

// --- Step 1: the Electron binary -----------------------------------------

function ensureElectron() {
  if (electronBin()) return
  log(`Electron ${electronVersion} binary missing — running electron/install.js`)
  if (run(process.execPath, [join(ROOT, 'node_modules', 'electron', 'install.js')]) && electronBin()) return

  // Direct download failed (its HTTP client dislikes some proxies). Seed the
  // @electron/get cache with curl — GitHub releases are usually reachable —
  // and let install.js pick it up from cache.
  const file = `electron-v${electronVersion}-${process.platform}-${process.arch}.zip`
  const url = `https://github.com/electron/electron/releases/download/v${electronVersion}/${file}`
  const u = new URL(url)
  u.hash = ''
  u.search = ''
  u.pathname = posix.dirname(u.pathname)
  const dir = join(homedir(), '.cache', 'electron', createHash('sha256').update(u.toString()).digest('hex'))
  mkdirSync(dir, { recursive: true })
  log(`seeding @electron/get cache from ${url}`)
  if (!run('curl', ['-fsSL', '--retry', '3', '-o', join(dir, file), url])) {
    fail(`could not download ${url} — is github.com allowed by the network policy?`)
  }
  if (!run(process.execPath, [join(ROOT, 'node_modules', 'electron', 'install.js')]) || !electronBin()) {
    fail('electron/install.js still failing after cache seed')
  }
}

// --- Step 2: better-sqlite3 built for Electron's ABI ----------------------

function sqliteSmoke() {
  return (
    inElectron(
      `const D=require('better-sqlite3');const d=new D(':memory:');` +
        `d.exec('CREATE TABLE t (a INTEGER, b BLOB)');` +
        `const blob=Buffer.from([1,2,3,4]);d.prepare('INSERT INTO t VALUES (?, ?)').run(7,blob);` +
        `const r=d.prepare('SELECT a, b FROM t').get();` +
        `if(r.a!==7||!Buffer.isBuffer(r.b)||r.b.length!==4)throw new Error('bad roundtrip');` +
        `d.close();console.log('sqlite-ok')`
    ) === 'sqlite-ok'
  )
}

function rebuild() {
  const bin = join(
    ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'electron-rebuild.cmd' : 'electron-rebuild'
  )
  return run(bin, ['-f', '-w', 'better-sqlite3'])
}

// Every path handed to sparseClone is a directory in the source repo, so a
// non-empty listing is the signal that the checkout actually landed.
function sparsePathsReady(dest, paths) {
  return paths.every((p) => {
    try {
      return readdirSync(join(dest, p.replace(/^\/+/, ''))).length > 0
    } catch {
      return false
    }
  })
}

function sparseClone(url, ref, dest, paths) {
  const checkout = () =>
    run('git', ['sparse-checkout', 'set', '--no-cone', ...paths], { cwd: dest }) &&
    sparsePathsReady(dest, paths)

  // A cached clone counts only once its sparse paths are materialized: git
  // creates .git before the checkout that fills them, so a connection lost
  // mid-checkout — the very failure this fallback exists for — leaves a .git
  // promising content it doesn't have. Trusting it would wedge every later
  // run, including the `npm run toolchain` meant to repair things.
  if (existsSync(join(dest, '.git'))) {
    if (sparsePathsReady(dest, paths)) return true
    log(`incomplete cached clone at ${dest} — retrying its sparse checkout`)
    if (checkout()) return true
    log('retry failed — re-cloning from scratch')
  }

  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dirname(dest), { recursive: true })
  if (!run('git', ['clone', '--depth', '1', '--branch', ref, '--filter=blob:none', '--sparse', url, dest])) {
    return false
  }
  return checkout()
}

// Assembles the node headers Electron addons compile against, equivalent to
// the artifacts.electronjs.org tarball, from hosts open in typical sandboxes:
//   base    upstream nodejs.org headers for Electron's bundled Node version
//   v8      include/ from the github.com/v8/v8 mirror at Electron's V8 tag
//           (Electron swaps Chromium's V8 in; upstream Node's V8 headers
//           would miscompile addons — pointer compression differs)
//   patches Electron's patch series hunks that touch shipped headers
//   config  config.gypi generated from the Electron binary's process.config
//           (authoritative build flags: V8_COMPRESS_POINTERS, sandbox, …)
//   abi     NODE_MODULE_VERSION forced to the binary's real ABI
function assembleHeaders() {
  if (process.platform === 'win32') {
    fail('header assembly fallback is not implemented for Windows — build on an open network instead')
  }
  const probe = JSON.parse(
    inElectron('console.log(JSON.stringify({v:process.versions,c:process.config}))') ??
      fail('cannot probe electron binary')
  )
  const nodeVer = probe.v.node
  const abi = probe.v.modules
  const v8Tag = probe.v.v8.replace(/-electron.*$/, '')
  const devDir = join(homedir(), '.electron-gyp', electronVersion)
  const marker = join(devDir, 'installVersion')
  const versionHeader = join(devDir, 'include', 'node', 'node_version.h')
  if (
    existsSync(marker) &&
    existsSync(versionHeader) &&
    readFileSync(versionHeader, 'utf8').includes(`NODE_MODULE_VERSION ${abi}`)
  ) {
    log(`headers already assembled at ${devDir}`)
    return
  }
  log(`assembling Electron ${electronVersion} headers (node ${nodeVer}, abi ${abi}, v8 ${v8Tag})`)
  rmSync(devDir, { recursive: true, force: true })
  mkdirSync(devDir, { recursive: true })

  const tarball = join(tmpdir(), `node-v${nodeVer}-headers.tar.gz`)
  if (
    !run('curl', [
      '-fsSL',
      '--retry',
      '3',
      '-o',
      tarball,
      `https://nodejs.org/dist/v${nodeVer}/node-v${nodeVer}-headers.tar.gz`
    ])
  ) {
    fail('could not download upstream node headers — is nodejs.org allowed by the network policy?')
  }
  if (!run('tar', ['xzf', tarball, '-C', devDir, '--strip-components=1']))
    fail('header tarball extract failed')

  const v8Src = join(CACHE, `v8-${v8Tag}`)
  if (!sparseClone('https://github.com/v8/v8.git', v8Tag, v8Src, ['/include'])) {
    fail(`could not clone v8 ${v8Tag} from the github mirror`)
  }
  const inc = join(devDir, 'include', 'node')
  for (const f of readdirSync(inc)) {
    if (f.startsWith('v8') && f.endsWith('.h')) rmSync(join(inc, f))
  }
  rmSync(join(inc, 'cppgc'), { recursive: true, force: true })
  rmSync(join(inc, 'libplatform'), { recursive: true, force: true })
  for (const f of readdirSync(join(v8Src, 'include'))) {
    if (f.endsWith('.h')) cpSync(join(v8Src, 'include', f), join(inc, f))
  }
  cpSync(join(v8Src, 'include', 'cppgc'), join(inc, 'cppgc'), { recursive: true })
  cpSync(join(v8Src, 'include', 'libplatform'), join(inc, 'libplatform'), { recursive: true })

  const elSrc = join(CACHE, `electron-${electronVersion}`)
  if (
    !sparseClone('https://github.com/electron/electron.git', `v${electronVersion}`, elSrc, [
      '/patches/node',
      '/patches/v8'
    ])
  ) {
    fail('could not clone electron patches')
  }
  // Apply only hunks that touch files shipped in the headers tree, and only
  // when they apply cleanly — everything else is source-only and irrelevant
  // to addon compilation. (-p2 maps a/src/x.h and a/include/x.h to inc/;
  // -p1 maps a/common.gypi.)
  const applyClasses = [
    { dir: 'patches/v8', strip: '-p2', include: '*.h' },
    { dir: 'patches/node', strip: '-p2', include: '*.h' },
    { dir: 'patches/node', strip: '-p1', include: 'common.gypi' }
  ]
  for (const { dir, strip, include } of applyClasses) {
    for (const p of readdirSync(join(elSrc, dir)).filter((f) => f.endsWith('.patch'))) {
      const patch = join(elSrc, dir, p)
      const args = [strip, `--include=${include}`]
      if (spawnSync('git', ['apply', ...args, '--check', patch], { cwd: inc }).status === 0) {
        spawnSync('git', ['apply', ...args, patch], { cwd: inc })
      }
    }
  }

  const vh = readFileSync(versionHeader, 'utf8')
  writeFileSync(
    versionHeader,
    vh.replace(/^#define NODE_MODULE_VERSION .*$/gm, `#define NODE_MODULE_VERSION ${abi}`)
  )

  const py = (v) => {
    if (v === null) return 'None'
    if (v === true) return 'True'
    if (v === false) return 'False'
    if (typeof v === 'number') return String(v)
    if (typeof v === 'string') return JSON.stringify(v)
    if (Array.isArray(v)) return `[${v.map(py).join(', ')}]`
    return `{${Object.entries(v)
      .map(([k, x]) => `${JSON.stringify(k)}: ${py(x)}`)
      .join(', ')}}`
  }
  writeFileSync(
    join(inc, 'config.gypi'),
    `# Generated from Electron process.config for native module builds.\n${py(probe.c)}\n`
  )
  writeFileSync(marker, '11\n')
  log(`headers ready at ${devDir}`)
}

function ensureBetterSqlite() {
  if (sqliteSmoke()) return
  log("better-sqlite3 doesn't load in Electron — rebuilding")
  if (rebuild() && sqliteSmoke()) return
  log('plain electron-rebuild failed (headers host likely blocked) — assembling headers locally')
  assembleHeaders()
  if (!rebuild() || !sqliteSmoke()) {
    fail(
      'better-sqlite3 still fails inside Electron. If this is a sandboxed environment, ' +
        'allow www.electronjs.org and artifacts.electronjs.org in the network policy ' +
        '(github.com and nodejs.org are also required).'
    )
  }
}

ensureElectron()
ensureBetterSqlite()
log(
  `ok — electron ${electronVersion} + better-sqlite3 verified (ABI ${inElectron('console.log(process.versions.modules)')})`
)
