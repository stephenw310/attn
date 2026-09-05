// The auto-update state machine (T39, SPEC §6): check on launch and every
// six hours, download in the background, surface "ready", and apply only on
// a normal or explicitly requested restart. Feed metadata declares the target
// schema and the oldest schema the release can migrate. Compatibility is
// checked before download and again before either install path.

import type { UpdateCheck, UpdateCheckOutcome, UpdatePhase, UpdateState } from '../../shared/distribution'
import { type SchedulerTime, systemTime, type TimerHandle } from '../time'

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000
/** Error backoff: 15m, doubling to a 6h cap; any success resets it. */
export const UPDATE_ERROR_BACKOFF_MS = 15 * 60 * 1_000

export interface UpdateFeedInfo {
  version: string
  /** The schema the target release opens after running its migrations. */
  requiredSchemaVersion: number | null
  /** The oldest existing profile the target release can migrate. */
  minimumSchemaVersion: number | null
}

/** The injected transport: electron-updater in production, fakes in tests. */
export interface UpdateFeed {
  /** The newest release the feed offers, or null when up to date. */
  check(): Promise<UpdateFeedInfo | null>
  download(info: UpdateFeedInfo): Promise<void>
  /** Hand over to the installer. It quits the app only after the handoff succeeds. */
  quitAndInstall(): void
  /**
   * Stage the downloaded update so the quit already in progress applies it,
   * without relaunching. Resolves once staging is done or has failed; a
   * failure must not hold the quit.
   */
  installOnQuit(): Promise<void>
}

export type { UpdatePhase, UpdateState }

export interface AppUpdaterOptions {
  feed: UpdateFeed
  /** The running build's version and schema snapshot. */
  currentVersion: string
  schemaVersion: number
  /** The local database's user_version at decision time; null rejects. */
  localSchemaVersion: () => number | null
  onStateChange: (state: UpdateState) => void
  time?: SchedulerTime
}

/**
 * Dotted-numeric version comparison. Every part must be a plain integer, so
 * a prerelease such as `1.0.0-beta.1` (which the release workflow refuses to
 * publish) or anything else unparsable never installs.
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (value: string): number[] | null => {
    const parts = value.replace(/^v/, '').split('.')
    if (parts.length === 0 || !parts.every((part) => /^\d+$/.test(part))) return null
    const numbers = parts.map((part) => Number.parseInt(part, 10))
    return numbers.every((part) => Number.isSafeInteger(part)) ? numbers : null
  }
  const target = parse(candidate)
  const base = parse(current)
  if (target === null || base === null) return false
  for (let index = 0; index < Math.max(target.length, base.length); index++) {
    const left = target[index] ?? 0
    const right = base[index] ?? 0
    if (left !== right) return left > right
  }
  return false
}

export class AppUpdater {
  private readonly time: SchedulerTime
  private phase: UpdatePhase = 'idle'
  private ready: UpdateFeedInfo | null = null
  private lastCheck: UpdateCheck | null = null
  private timer: TimerHandle | null = null
  private inFlight: Promise<void> | null = null
  private backoffMs = UPDATE_ERROR_BACKOFF_MS
  private stopped = false
  private applying = false

  constructor(private readonly options: AppUpdaterOptions) {
    this.time = options.time ?? systemTime
  }

  state(): UpdateState {
    return { phase: this.phase, readyVersion: this.ready?.version ?? null, lastCheck: this.lastCheck }
  }

  /** Check now, then keep the six-hour cadence. */
  start(): void {
    void this.runCheck()
  }

  /**
   * The Settings button and the palette's `Check for updates`: run one check
   * immediately (joining one already in flight) and resolve with the state
   * it left behind. The cadence timer restarts from this check, so a manual
   * check never stacks a second scheduled one on top of it.
   */
  async checkNow(): Promise<UpdateState> {
    if (this.inFlight === null) {
      if (this.timer !== null) {
        this.time.timers.clearTimeout(this.timer)
        this.timer = null
      }
      void this.runCheck()
    }
    await this.inFlight
    return this.state()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      this.time.timers.clearTimeout(this.timer)
      this.timer = null
    }
  }

  /**
   * The target is installable when it is newer and its retained migration
   * range contains this build's open database. Re-check before installation
   * because an operator can replace the database after the download.
   */
  private classify(info: UpdateFeedInfo): Exclude<UpdateCheckOutcome, 'error'> {
    if (!isNewerVersion(info.version, this.options.currentVersion)) return 'up-to-date'
    if (info.requiredSchemaVersion === null) return 'incompatible'
    if (info.minimumSchemaVersion === null) return 'incompatible'
    const local = this.options.localSchemaVersion()
    if (local === null || local !== this.options.schemaVersion) return 'incompatible'
    const minimum = info.minimumSchemaVersion
    if (minimum > info.requiredSchemaVersion) return 'incompatible'
    if (local < minimum || local > info.requiredSchemaVersion) return 'incompatible'
    return 'available'
  }

  private compatible(info: UpdateFeedInfo): boolean {
    return this.classify(info) === 'available'
  }

  private recordCheck(outcome: UpdateCheckOutcome, version: string | null): void {
    this.lastCheck = { at: this.time.now(), outcome, version }
  }

  private setPhase(phase: UpdatePhase): void {
    if (this.phase === phase) return
    this.phase = phase
    this.options.onStateChange(this.state())
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return
    if (this.timer !== null) this.time.timers.clearTimeout(this.timer)
    this.timer = this.time.timers.setTimeout(() => {
      this.timer = null
      void this.runCheck()
    }, delayMs)
  }

  private runCheck(): Promise<void> {
    if (this.inFlight !== null) return this.inFlight
    this.inFlight = this.performCheck().finally(() => {
      this.inFlight = null
    })
    return this.inFlight
  }

  private async performCheck(): Promise<void> {
    if (this.stopped || this.applying) return
    // A downloaded update waits for a restart; polling again cannot improve
    // on it and a second download could race the installer handoff.
    if (this.phase === 'ready') {
      this.schedule(UPDATE_CHECK_INTERVAL_MS)
      return
    }
    this.setPhase('checking')
    try {
      const info = await this.options.feed.check()
      if (this.stopped) return
      const outcome = info === null ? 'up-to-date' : this.classify(info)
      this.recordCheck(outcome, outcome === 'up-to-date' ? null : (info?.version ?? null))
      if (info === null || outcome !== 'available') {
        this.setPhase('idle')
      } else {
        this.setPhase('downloading')
        await this.options.feed.download(info)
        if (this.stopped) return
        this.ready = info
        this.setPhase('ready')
      }
      this.backoffMs = UPDATE_ERROR_BACKOFF_MS
      this.schedule(UPDATE_CHECK_INTERVAL_MS)
    } catch {
      if (this.stopped) return
      // Errors stay quiet (the next check may succeed); backoff doubles to
      // the ordinary cadence cap so a broken feed is not hammered.
      this.recordCheck('error', null)
      this.setPhase('idle')
      this.schedule(this.backoffMs)
      this.backoffMs = Math.min(this.backoffMs * 2, UPDATE_CHECK_INTERVAL_MS)
    }
  }

  /**
   * The cached download is installable only if it still passes the same
   * check it passed before download — schema agreement can have changed
   * since it landed (a manual dogfood upgrade), and a stale cache must never
   * install. A rejected cache is dropped so the next check can replace it.
   */
  private claimReadyForInstall(): UpdateFeedInfo | null {
    const info = this.ready
    if (this.applying || this.phase !== 'ready' || info === null) return null
    if (!this.compatible(info)) {
      this.ready = null
      this.setPhase('idle')
      return null
    }
    this.applying = true
    this.stop()
    return info
  }

  /**
   * The palette's `Restart to update`: re-validate and ask the installer to
   * relaunch. electron-updater initiates the platform handoff first and calls
   * app.quit() only when it succeeds. The ordinary before-quit path then
   * checkpoints composers and stops workers. Returns false when nothing
   * installable is ready.
   */
  async restartToApply(): Promise<boolean> {
    if (this.claimReadyForInstall() === null) return false
    try {
      this.options.feed.quitAndInstall()
      return true
    } catch {
      // A synchronous platform handoff failure leaves the app running. Restore
      // the ready state so the user can retry instead of wedging the updater.
      this.applying = false
      this.stopped = false
      this.schedule(UPDATE_CHECK_INTERVAL_MS)
      return false
    }
  }

  /**
   * The ordinary quit: main calls this from its quit preparation, after the
   * composers have checkpointed. A ready, still-compatible download is staged
   * so the quit applies it; anything else is left alone. electron-updater's
   * own install-on-quit is disabled precisely so this re-validation is the
   * only path to an install.
   */
  async installOnQuit(): Promise<void> {
    if (this.claimReadyForInstall() === null) return
    await this.options.feed.installOnQuit()
  }
}
