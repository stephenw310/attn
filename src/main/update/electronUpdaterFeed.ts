// electron-updater bound to the injected-feed contract (T39). Constructed
// only when shouldConstructUpdater allowed it: a packaged release build with
// a declared GitHub Releases feed, outside the test harness.
//
// The feed is per schema version: the app reads latest.yml / latest-mac.yml
// from the rolling `feed-schema-<n>` release of the feed repository (the
// generic provider, so nothing depends on which release GitHub calls
// "latest"), and each entry names the versioned release's assets by absolute
// URL. Publishing a release for a newer schema therefore never hides later
// maintenance releases from installations still on the old schema. Every
// entry must still carry requiredSchemaVersion; its absence is surfaced as
// null and the state machine rejects the update.

import type { DistributionMetadata } from '../../shared/distribution'
import { schemaFeedUrl } from '../../shared/distribution'
import type { UpdateFeed, UpdateFeedInfo } from './updater'

/** Squirrel.Mac staging at quit is bounded so a wedged updater cannot hold the quit. */
const MAC_STAGING_TIMEOUT_MS = 30_000

interface ElectronUpdateInfo {
  version: string
  requiredSchemaVersion?: unknown
}

interface ElectronAutoUpdater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowDowngrade: boolean
  setFeedURL(options: { provider: 'generic'; url: string }): void
  checkForUpdates(): Promise<{ updateInfo: ElectronUpdateInfo; isUpdateAvailable?: boolean } | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
  /** Windows: run the downloaded installer against the quit in progress. */
  install(isSilent?: boolean, isForceRunAfter?: boolean): boolean
}

/** Electron's own Squirrel.Mac bridge, which electron-updater feeds through a local proxy. */
interface NativeMacUpdater {
  checkForUpdates(): void
  once(event: 'update-downloaded' | 'error', listener: () => void): unknown
  removeListener(event: 'update-downloaded' | 'error', listener: () => void): unknown
}

function requiredSchemaOf(info: ElectronUpdateInfo): number | null {
  const declared = info.requiredSchemaVersion
  if (typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0) return declared
  // latest.yml round-trips unknown keys as strings in some builder versions.
  if (typeof declared === 'string' && /^[0-9]+$/.test(declared)) return Number.parseInt(declared, 10)
  return null
}

/**
 * macOS: electron-updater has downloaded the ZIP and parked a local proxy for
 * Squirrel.Mac; asking Electron's native updater to check now makes Squirrel
 * fetch and stage it, and a staged update is applied when the app exits.
 * Windows: the NSIS installer is spawned silently and waits for the exit.
 */
function stageForQuit(autoUpdater: ElectronAutoUpdater): Promise<void> {
  if (process.platform !== 'darwin') {
    autoUpdater.install(true, false)
    return Promise.resolve()
  }
  const native = (require('electron') as { autoUpdater: NativeMacUpdater }).autoUpdater
  return new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const settle = (): void => {
      if (timer !== null) clearTimeout(timer)
      native.removeListener('update-downloaded', settle)
      native.removeListener('error', settle)
      resolve()
    }
    timer = setTimeout(() => {
      console.warn('[update] Squirrel.Mac staging timed out before quit')
      settle()
    }, MAC_STAGING_TIMEOUT_MS)
    native.once('update-downloaded', settle)
    native.once('error', settle)
    native.checkForUpdates()
  })
}

/** Build the production feed. The metadata has already passed the gate. */
export function createElectronUpdaterFeed(metadata: DistributionMetadata, schemaVersion: number): UpdateFeed {
  // Deferred require keeps electron-updater wholly out of personal, dev, and
  // e2e processes — no module side effects, no cache probes, no feed traffic.
  const { autoUpdater } = require('electron-updater') as { autoUpdater: ElectronAutoUpdater }
  const feed = metadata.feed
  if (!feed) throw new Error('release metadata without a feed cannot update')
  autoUpdater.autoDownload = false
  // Installing on quit is the state machine's decision, after it re-validates
  // the cached download; the library's own quit hook would skip that check.
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowDowngrade = false
  autoUpdater.setFeedURL({ provider: 'generic', url: schemaFeedUrl(feed, schemaVersion) })
  return {
    check: async (): Promise<UpdateFeedInfo | null> => {
      const result = await autoUpdater.checkForUpdates()
      if (!result || result.isUpdateAvailable === false) return null
      return {
        version: result.updateInfo.version,
        requiredSchemaVersion: requiredSchemaOf(result.updateInfo)
      }
    },
    download: async (): Promise<void> => {
      await autoUpdater.downloadUpdate()
    },
    quitAndInstall: (): void => {
      // This is only reached from the explicit `Restart to update` action, so
      // the user asked for a relaunch: isForceRunAfter must be true or the
      // silent Windows installer leaves the app closed (PR #101 review). On
      // macOS electron-updater stages through Squirrel first, then relaunches.
      autoUpdater.quitAndInstall(true, true)
    },
    installOnQuit: (): Promise<void> => stageForQuit(autoUpdater)
  }
}
