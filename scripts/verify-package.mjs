import { access, readdir } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { listPackage, statFile } from '@electron/asar'

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = join(projectDir, 'dist')
const requiredEntries = [
  '/out/main/index.js',
  '/out/main/service/utility.js',
  '/out/preload/index.js',
  '/out/renderer/index.html',
  '/node_modules/jsdom/lib/api.js',
  '/package.json',
  '/resources/icon.png',
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

  console.log(`[package] verified ${relative(projectDir, archive)} (${platform}-${arch})`)
}

const archives = await findAppArchives(outputDir)
if (archives.length === 0) {
  throw new Error(`No packaged app.asar files found under ${outputDir}`)
}

for (const archive of archives) {
  await verifyArchive(archive)
}
