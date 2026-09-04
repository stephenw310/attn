// The auto-update state machine (T39, SPEC §6): check on launch and every
// six hours, download in the background, surface "ready", and apply only on
// a normal or explicitly requested restart — never a forced one. The feed is
// injected (electron-updater in production, fakes in tests) and time rides
// SchedulerTime. Updates never cross a schema version: the running build,
// the local database, and the target release must agree exactly, checked
// before download AND again before install so a stale cached download can
// never slip through.

import type { UpdatePhase, UpdateState } from '../../shared/distribution'
import { type SchedulerTime, systemTime, type TimerHandle } from '../time'

export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1_000
/** Error backoff: 15m, doubling to a 6h cap; any success resets it. */
export const UPDATE_ERROR_BACKOFF_MS = 15 * 60 * 1_000

export interface UpdateFeedInfo {
  version: string
  /** From release metadata; null when absent — absent always rejects. */
  requiredSchemaVersion: number | null
}

/** The injected transport: electron-updater in production, fakes in tests. */
export interface UpdateFeed {
  /** The newest release the feed offers, or null when up to date. */
  check(): Promise<UpdateFeedInfo | null>
  download(info: UpdateFeedInfo): Promise<void>
  /** Hand over to the installer. The caller has already quiesced workers. */
  quitAndInstall(): void
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
  /** The existing awaited shutdown: draft mirroring and sends quiesce here. */
  shutdown: () => Promise<void>
  time?: SchedulerTime
}

/** Dotted-numeric version comparison; an unparsable target never installs. */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (value: string): number[] | null => {
    const parts = value.replace(/^v/, '').split('.')
    const numbers = parts.map((part) => Number.parseInt(part, 10))
    return numbers.length > 0 && numbers.every((part) => Number.isSafeInteger(part) && part >= 0)
      ? numbers
      : null
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
  private timer: TimerHandle | null = null
  private backoffMs = UPDATE_ERROR_BACKOFF_MS
  private stopped = false
  private applying = false

  constructor(private readonly options: AppUpdaterOptions) {
    this.time = options.time ?? systemTime
  }

  state(): UpdateState {
    return { phase: this.phase, readyVersion: this.ready?.version ?? null }
  }

  /** Check now, then keep the six-hour cadence. */
  start(): void {
    void this.runCheck()
  }

  stop(): void {
    this.stopped = true
    if (this.timer !== null) {
      this.time.timers.clearTimeout(this.timer)
      this.timer = null
    }
  }

  /**
   * The target release is installable only when its declared schema exactly
   * matches both the running build and the local database, and its version
   * is genuinely newer. Checked before download and re-checked before
   * install; a null anywhere rejects.
   */
  private compatible(info: UpdateFeedInfo): boolean {
    if (!isNewerVersion(info.version, this.options.currentVersion)) return false
    if (info.requiredSchemaVersion === null) return false
    if (info.requiredSchemaVersion !== this.options.schemaVersion) return false
    return this.options.localSchemaVersion() === info.requiredSchemaVersion
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

  private async runCheck(): Promise<void> {
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
      if (info === null || !this.compatible(info)) {
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
      this.setPhase('idle')
      this.schedule(this.backoffMs)
      this.backoffMs = Math.min(this.backoffMs * 2, UPDATE_CHECK_INTERVAL_MS)
    }
  }

  /**
   * The palette's `Restart to update`: re-validate the cached download —
   * schema agreement can have changed since it landed, and a stale cache
   * must never install — then quiesce the workers and hand over. Returns
   * false when nothing installable is ready.
   */
  async restartToApply(): Promise<boolean> {
    const info = this.ready
    if (this.applying || this.phase !== 'ready' || info === null) return false
    if (!this.compatible(info)) {
      this.ready = null
      this.setPhase('idle')
      return false
    }
    this.applying = true
    this.stop()
    await this.options.shutdown()
    this.options.feed.quitAndInstall()
    return true
  }
}
