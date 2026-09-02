// electron-updater bound to the injected-feed contract (T39). Constructed
// only when shouldConstructUpdater allowed it: a packaged release build with
// a declared GitHub Releases feed, outside the test harness. The feed's
// per-release metadata must carry requiredSchemaVersion; its absence is
// surfaced as null and the state machine rejects the update.

import type { DistributionMetadata } from '../../shared/distribution'
import type { UpdateFeed, UpdateFeedInfo } from './updater'

interface ElectronUpdateInfo {
  version: string
  requiredSchemaVersion?: unknown
}

interface ElectronAutoUpdater {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowDowngrade: boolean
  setFeedURL(options: { provider: 'github'; owner: string; repo: string }): void
  checkForUpdates(): Promise<{ updateInfo: ElectronUpdateInfo; isUpdateAvailable?: boolean } | null>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

function requiredSchemaOf(info: ElectronUpdateInfo): number | null {
  const declared = info.requiredSchemaVersion
  if (typeof declared === 'number' && Number.isSafeInteger(declared) && declared > 0) return declared
  // latest.yml round-trips unknown keys as strings in some builder versions.
  if (typeof declared === 'string' && /^[0-9]+$/.test(declared)) return Number.parseInt(declared, 10)
  return null
}

/** Build the production feed. The metadata has already passed the gate. */
export function createElectronUpdaterFeed(metadata: DistributionMetadata): UpdateFeed {
  // Deferred require keeps electron-updater wholly out of personal, dev, and
  // e2e processes — no module side effects, no cache probes, no feed traffic.
  const { autoUpdater } = require('electron-updater') as { autoUpdater: ElectronAutoUpdater }
  const feed = metadata.feed
  if (!feed) throw new Error('release metadata without a feed cannot update')
  autoUpdater.autoDownload = false
  // A normal quit applies a downloaded update; nothing ever forces a restart.
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowDowngrade = false
  autoUpdater.setFeedURL({ provider: 'github', owner: feed.owner, repo: feed.repo })
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
      // silent Windows installer leaves the app closed (PR #101 review). The
      // never-forced path stays autoInstallOnAppQuit, which does not relaunch.
      autoUpdater.quitAndInstall(true, true)
    }
  }
}
