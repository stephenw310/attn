import { execFileSync } from 'node:child_process'
import { access, readdir, readFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listPackage, statFile } from '@electron/asar'

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
  const nativeEntry = `/node_modules/better-sqlite3/prebuilds/${platform}-${arch}.node`
  const nativeEntries = entries.filter((entry) => entry.endsWith('.node'))

  if (nativeEntries.length !== 1 || nativeEntries[0] !== nativeEntry) {
    throw new Error(
      `${relative(projectDir, archive)} must contain only ${nativeEntry}; found ${nativeEntries.join(', ')}`
    )
  }

  const nativeMetadata = statFile(archive, nativeEntry.slice(1))
  if (!nativeMetadata.unpacked) {
    throw new Error(`${nativeEntry} must be unpacked for Electron to load it`)
  }

  await access(join(dirname(archive), 'app.asar.unpacked', nativeEntry.slice(1)))
  await verifyDistributionMetadata(archive)
  if (releaseMode) verifyReleaseSignature(archive, platform)

  console.log(`[package] verified ${relative(projectDir, archive)} (${platform}-${arch})`)
}

async function packagedSchemaVersion() {
  const schema = await readFile(join(projectDir, 'src/main/db/schema.ts'), 'utf8')
  const match = schema.match(/CURRENT_SCHEMA_VERSION = (\d+)/)
  if (!match) throw new Error('CURRENT_SCHEMA_VERSION not found in src/main/db/schema.ts')
  return Number.parseInt(match[1], 10)
}

/**
 * The packaged distribution metadata (T39): every build must declare its
 * mode and the exact schema snapshot it runs. Personal artifacts must say so
 * (updater disabled); `--release` refuses to publish anything else, so a
 * failed release check fails publication instead of falling back to
 * personal. The runtime treats missing metadata as personal — this check is
 * what keeps missing metadata from shipping in the first place.
 */
async function verifyDistributionMetadata(archive) {
  const path = join(dirname(archive), 'distribution.json')
  let metadata
  try {
    metadata = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    throw new Error(`${relative(projectDir, archive)} has no readable distribution.json beside app.asar`)
  }
  const schemaVersion = await packagedSchemaVersion()
  if (metadata?.metadataVersion !== 1) throw new Error(`${path}: unknown metadataVersion`)
  if (metadata.schemaVersion !== schemaVersion) {
    throw new Error(
      `${path}: declares schema v${metadata.schemaVersion}, packaged build is v${schemaVersion}`
    )
  }
  if (releaseMode) {
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
    // signature. `signtool` exists on the Windows release runner.
    const installer = process.env.ATTN_RELEASE_INSTALLER
    if (!installer) {
      throw new Error('release verification on Windows requires ATTN_RELEASE_INSTALLER=<path to .exe>')
    }
    execFileSync('signtool', ['verify', '/pa', installer], { stdio: 'pipe' })
    return
  }
  throw new Error(`${platform} artifacts are not a release target`)
}

const archives = await findAppArchives(outputDir)
if (archives.length === 0) {
  throw new Error(`No packaged app.asar files found under ${outputDir}`)
}

for (const archive of archives) {
  await verifyArchive(archive)
}
