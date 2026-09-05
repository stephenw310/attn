import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { access, readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listPackage, statFile } from '@electron/asar'
import { packagedSchemaVersions } from './write-distribution-metadata.mjs'

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = join(projectDir, 'dist')
// T39: `--release` additionally requires release metadata and real
// signatures; the default personal mode requires the updater-disabled
// metadata and no credentials at all.
const releaseMode = process.argv.includes('--release')
const requiredEntries = [
  '/out/main/index.js',
  '/out/main/service/utility.js',
  '/out/preload/index.js',
  '/out/renderer/index.html',
  '/node_modules/jsdom/lib/api.js',
  '/package.json',
  '/resources/icon.png',
  '/resources/menuBarTemplate.png',
  '/resources/tray.png'
]

async function findAppArchives(directory) {
  const archives = []

  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name)
    if (entry.isDirectory()) {
      archives.push(...(await findAppArchives(entryPath)))
    } else if (entry.isFile() && entry.name === 'app.asar') {
      archives.push(entryPath)
    }
  }

  return archives
}

function targetForArchive(archive) {
  const normalized = archive.split(sep).join('/')
  const targets = [
    ['/mac-arm64/', 'darwin', 'arm64'],
    ['/mac/', 'darwin', 'x64'],
    ['/win-arm64-unpacked/', 'win32', 'arm64'],
    ['/win-ia32-unpacked/', 'win32', 'ia32'],
    ['/win-unpacked/', 'win32', 'x64'],
    ['/linux-arm64-unpacked/', 'linux', 'arm64'],
    ['/linux-unpacked/', 'linux', 'x64']
  ]
  const target = targets.find(([fragment]) => normalized.includes(fragment))

  if (!target) {
    throw new Error(`Cannot determine package platform and architecture from ${archive}`)
  }

  return { platform: target[1], arch: target[2] }
}

async function verifyArchive(archive) {
  const entries = listPackage(archive).map((entry) => entry.replaceAll('\\', '/'))
  const entrySet = new Set(entries)

  for (const entry of requiredEntries) {
    if (!entrySet.has(entry)) {
      throw new Error(`${relative(projectDir, archive)} is missing ${entry}`)
    }
  }

  const { platform, arch } = targetForArchive(archive)
  const nativeRelativePath = join('node_modules', 'better-sqlite3', 'prebuilds', `${platform}-${arch}.node`)
  const nativeEntry = `/${nativeRelativePath.split(sep).join('/')}`
  const nativeEntries = entries.filter((entry) => entry.endsWith('.node'))

  if (nativeEntries.length !== 1 || nativeEntries[0] !== nativeEntry) {
    throw new Error(
      `${relative(projectDir, archive)} must contain only ${nativeEntry}; found ${nativeEntries.join(', ')}`
    )
  }

  // Renderer-only packages are bundled into out/renderer, so shipping their
  // sources means they drifted back into runtime `dependencies`.
  const rendererOnly = entries.filter((entry) => entry.startsWith('/node_modules/@dnd-kit/'))
  if (rendererOnly.length > 0) {
    throw new Error(
      `${relative(projectDir, archive)} ships bundled-only @dnd-kit sources; keep them in devDependencies`
    )
  }

  // @electron/asar traverses archive metadata with the host platform's path
  // separator. Keep the canonical slash form above for portable comparisons,
  // but use the native relative path for metadata lookup on Windows.
  const nativeMetadata = statFile(archive, nativeRelativePath)
  if (!nativeMetadata.unpacked) {
    throw new Error(`${nativeEntry} must be unpacked for Electron to load it`)
  }

  await access(join(dirname(archive), 'app.asar.unpacked', nativeRelativePath))
  await verifyDistributionMetadata(archive, releaseMode)
  if (releaseMode) verifyReleaseSignature(archive, platform)

  console.log(`[package] verified ${relative(projectDir, archive)} (${platform}-${arch})`)
}

/**
 * The packaged distribution metadata (T39): every build must declare its
 * mode and the exact schema snapshot it runs. Personal artifacts must say so
 * (updater disabled); `--release` refuses to publish anything else, so a
 * failed release check fails publication instead of falling back to
 * personal. The runtime treats missing metadata as personal — this check is
 * what keeps missing metadata from shipping in the first place.
 */
export async function verifyDistributionMetadata(archive, release = false) {
  const path = join(dirname(archive), 'distribution.json')
  let metadata
  try {
    metadata = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new Error(`${relative(projectDir, archive)} has no readable distribution.json beside app.asar`)
  }
  const { schemaVersion, minimumSchemaVersion } = packagedSchemaVersions()
  if (metadata?.metadataVersion !== 2) throw new Error(`${path}: unknown metadataVersion`)
  if (metadata.schemaVersion !== schemaVersion) {
    throw new Error(
      `${path}: declares schema v${metadata.schemaVersion}, packaged build is v${schemaVersion}`
    )
  }
  if (metadata.minimumSchemaVersion !== minimumSchemaVersion) {
    throw new Error(
      `${path}: declares minimum schema v${metadata.minimumSchemaVersion}, packaged build is v${minimumSchemaVersion}`
    )
  }
  if (release) {
    if (metadata.mode !== 'release') {
      throw new Error(`${path}: a personal artifact cannot be published — --release requires mode "release"`)
    }
    if (!metadata.feed?.owner || !metadata.feed?.repo) {
      throw new Error(`${path}: release metadata must declare its update feed (owner/repo)`)
    }
  } else if (metadata.mode !== 'personal' || metadata.feed !== undefined) {
    throw new Error(
      `${path}: personal packaging must declare mode "personal" with no feed (updater disabled)`
    )
  }
}

/**
 * Release-only artifact checks. These run on the OS that built the artifact
 * (the release workflow's runners); a missing tool or an unexpected platform
 * fails the release rather than skipping the check.
 */
function verifyReleaseSignature(archive, platform) {
  if (platform === 'darwin') {
    const bundle = resolve(dirname(archive), '..', '..')
    execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'pipe' })
    execFileSync('xcrun', ['stapler', 'validate', bundle], { stdio: 'pipe' })
    return
  }
  if (platform === 'win32') {
    // The NSIS installer is the shipped artifact; require its Authenticode
    // signature. ATTN_RELEASE_INSTALLER names it explicitly; otherwise the
    // one installer in dist/ is it.
    const installer = process.env.ATTN_RELEASE_INSTALLER ?? releaseInstaller()
    execFileSync(findSigntool(), ['verify', '/pa', installer], { stdio: 'pipe' })
    return
  }
  throw new Error(`${platform} artifacts are not a release target`)
}

function releaseInstaller() {
  const installers = readdirSync(outputDir).filter((name) => name.endsWith('.exe'))
  if (installers.length !== 1) {
    throw new Error(
      `expected exactly one installer in ${outputDir}, found ${installers.length}; set ATTN_RELEASE_INSTALLER`
    )
  }
  return join(outputDir, installers[0])
}

/**
 * `signtool` is not on PATH on a stock Windows runner. Prefer PATH, then the
 * Windows SDK installs, newest kit first.
 */
function findSigntool() {
  try {
    execFileSync('where', ['signtool'], { stdio: 'pipe' })
    return 'signtool'
  } catch {
    // fall through to the SDK search
  }
  const kits = join(
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    'Windows Kits',
    '10',
    'bin'
  )
  if (existsSync(kits)) {
    const versions = readdirSync(kits)
      .filter((name) => /^\d+\.\d+/.test(name))
      .sort()
      .reverse()
    for (const version of versions) {
      const candidate = join(kits, version, 'x64', 'signtool.exe')
      if (existsSync(candidate)) return candidate
    }
  }
  throw new Error('signtool.exe not found on PATH or under the Windows 10 SDK; install the Windows SDK')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const archives = await findAppArchives(outputDir)
  if (archives.length === 0) {
    throw new Error(`No packaged app.asar files found under ${outputDir}`)
  }

  for (const archive of archives) {
    await verifyArchive(archive)
  }
}
