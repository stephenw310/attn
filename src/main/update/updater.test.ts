import { describe, expect, it, vi } from 'vitest'
import type { SchedulerTime, TimerHandle } from '../time'
import {
  AppUpdater,
  isNewerVersion,
  UPDATE_CHECK_INTERVAL_MS,
  UPDATE_ERROR_BACKOFF_MS,
  type UpdateFeed,
  type UpdateFeedInfo,
  type UpdateState
} from './updater'

class ManualTimers {
  private next = 1
  readonly pending = new Map<number, { callback: () => void; delayMs: number }>()

  readonly time: SchedulerTime = {
    now: () => 0,
    timers: {
      setTimeout: (callback, delayMs) => {
        const id = this.next++
        this.pending.set(id, { callback, delayMs })
        return id as unknown as TimerHandle
      },
      clearTimeout: (handle) => {
        this.pending.delete(handle as unknown as number)
      }
    }
  }

  delays(): number[] {
    return [...this.pending.values()].map((entry) => entry.delayMs)
  }

  fireAll(): void {
    for (const [id, entry] of [...this.pending]) {
      this.pending.delete(id)
      entry.callback()
    }
  }
}

interface FeedScript {
  check?: () => Promise<UpdateFeedInfo | null>
  downloadError?: boolean
}

function harness(script: FeedScript = {}, localSchema: number | null = 24) {
  const timers = new ManualTimers()
  const states: UpdateState[] = []
  const calls = { check: 0, download: 0, install: 0, stage: 0 }
  const shutdown = vi.fn(async () => {})
  const feed: UpdateFeed = {
    check: async () => {
      calls.check++
      return script.check ? script.check() : null
    },
    download: async () => {
      calls.download++
      if (script.downloadError) throw new Error('download failed')
    },
    quitAndInstall: () => {
      calls.install++
    },
    installOnQuit: async () => {
      calls.stage++
    }
  }
  const updater = new AppUpdater({
    feed,
    currentVersion: '1.0.0',
    schemaVersion: 24,
    localSchemaVersion: () => localSchema,
    onStateChange: (state) => states.push(state),
    shutdown,
    time: timers.time
  })
  return { updater, timers, states, calls, shutdown }
}

const compatibleInfo: UpdateFeedInfo = { version: '1.1.0', requiredSchemaVersion: 24 }

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('isNewerVersion', () => {
  it('compares dotted numerics and never trusts garbage', () => {
    expect(isNewerVersion('1.1.0', '1.0.9')).toBe(true)
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true)
    expect(isNewerVersion('1.0.0', '1.0.0')).toBe(false)
    expect(isNewerVersion('0.9.9', '1.0.0')).toBe(false)
    expect(isNewerVersion('not-a-version', '1.0.0')).toBe(false)
    // Prereleases are never published; a parser that read "0-beta" as 0
    // would let a beta client refuse the final release (PR #114 review).
    expect(isNewerVersion('1.0.0-beta.1', '0.9.0')).toBe(false)
    expect(isNewerVersion('1.0.0', '1.0.0-beta.1')).toBe(false)
  })
})

describe('cadence and state machine', () => {
  it('checks on launch, lands ready, and keeps the six-hour cadence', async () => {
    const h = harness({ check: async () => compatibleInfo })
    h.updater.start()
    await settle()
    expect(h.calls).toMatchObject({ check: 1, download: 1 })
    expect(h.updater.state()).toEqual({
      phase: 'ready',
      readyVersion: '1.1.0',
      lastCheck: { at: 0, outcome: 'available', version: '1.1.0' }
    })
    expect(h.states.map((state) => state.phase)).toEqual(['checking', 'downloading', 'ready'])
    expect(h.timers.delays()).toEqual([UPDATE_CHECK_INTERVAL_MS])
    // A later tick never re-downloads a ready update.
    h.timers.fireAll()
    await settle()
    expect(h.calls.download).toBe(1)
  })

  it('an up-to-date feed returns to idle on the ordinary cadence', async () => {
    const h = harness()
    h.updater.start()
    await settle()
    expect(h.updater.state()).toEqual({
      phase: 'idle',
      readyVersion: null,
      lastCheck: { at: 0, outcome: 'up-to-date', version: null }
    })
    expect(h.timers.delays()).toEqual([UPDATE_CHECK_INTERVAL_MS])
  })

  it('records why a newer release did not download, and a failed check as an error', async () => {
    const incompatible = harness({ check: async () => ({ version: '2.0.0', requiredSchemaVersion: 25 }) })
    incompatible.updater.start()
    await settle()
    expect(incompatible.calls.download).toBe(0)
    expect(incompatible.updater.state().lastCheck).toEqual({
      at: 0,
      outcome: 'incompatible',
      version: '2.0.0'
    })

    const failing = harness({
      check: async () => {
        throw new Error('feed down')
      }
    })
    failing.updater.start()
    await settle()
    expect(failing.updater.state().lastCheck).toEqual({ at: 0, outcome: 'error', version: null })
  })

  it('checkNow runs one check, joins an in-flight one, and restarts the cadence from it', async () => {
    const pending: { release: () => void } = { release: () => {} }
    const h = harness({
      check: () =>
        new Promise((resolve) => {
          pending.release = () => resolve(null)
        })
    })
    h.updater.start()
    await settle()
    expect(h.calls.check).toBe(1)
    // A second request while the first is still answering joins it.
    const joined = h.updater.checkNow()
    await settle()
    expect(h.calls.check).toBe(1)
    pending.release()
    expect((await joined).lastCheck?.outcome).toBe('up-to-date')
    expect(h.timers.delays()).toEqual([UPDATE_CHECK_INTERVAL_MS])

    // A manual check replaces the pending scheduled one rather than stacking.
    const manual = h.updater.checkNow()
    await settle()
    expect(h.calls.check).toBe(2)
    pending.release()
    await manual
    expect(h.timers.delays()).toEqual([UPDATE_CHECK_INTERVAL_MS])
  })

  it('errors back off doubling to the cadence cap and a success resets', async () => {
    let fail = true
    const h = harness({
      check: async () => {
        if (fail) throw new Error('feed down')
        return null
      }
    })
    h.updater.start()
    await settle()
    expect(h.timers.delays()).toEqual([UPDATE_ERROR_BACKOFF_MS])
    h.timers.fireAll()
    await settle()
    expect(h.timers.delays()).toEqual([UPDATE_ERROR_BACKOFF_MS * 2])
    fail = false
    h.timers.fireAll()
    await settle()
    expect(h.timers.delays()).toEqual([UPDATE_CHECK_INTERVAL_MS])
  })
})

describe('schema gating', () => {
  it('missing schema metadata rejects before download', async () => {
    const h = harness({ check: async () => ({ version: '1.1.0', requiredSchemaVersion: null }) })
    h.updater.start()
    await settle()
    expect(h.calls.download).toBe(0)
    expect(h.updater.state().phase).toBe('idle')
  })

  it('a target for another schema never downloads', async () => {
    const h = harness({ check: async () => ({ version: '1.1.0', requiredSchemaVersion: 25 }) })
    h.updater.start()
    await settle()
    expect(h.calls.download).toBe(0)
  })

  it('a local database that disagrees rejects even a matching build', async () => {
    const h = harness({ check: async () => compatibleInfo }, 23)
    h.updater.start()
    await settle()
    expect(h.calls.download).toBe(0)
  })

  it('an unreadable local schema rejects rather than guessing', async () => {
    const h = harness({ check: async () => compatibleInfo }, null)
    h.updater.start()
    await settle()
    expect(h.calls.download).toBe(0)
  })

  it('a non-newer version never downloads', async () => {
    const h = harness({ check: async () => ({ version: '1.0.0', requiredSchemaVersion: 24 }) })
    h.updater.start()
    await settle()
    expect(h.calls.download).toBe(0)
  })
})

describe('restart to apply', () => {
  it('awaits the worker shutdown before handing over to the installer', async () => {
    const order: string[] = []
    const h = harness({ check: async () => compatibleInfo })
    h.shutdown.mockImplementation(async () => {
      order.push('shutdown')
    })
    h.updater.start()
    await settle()
    const original = h.calls
    const installed = await h.updater.restartToApply()
    order.push(`install:${original.install}`)
    expect(installed).toBe(true)
    expect(h.shutdown).toHaveBeenCalledTimes(1)
    expect(h.calls.install).toBe(1)
    expect(order[0]).toBe('shutdown')
  })

  it('refuses with nothing ready and never installs twice', async () => {
    const h = harness()
    h.updater.start()
    await settle()
    expect(await h.updater.restartToApply()).toBe(false)
    expect(h.calls.install).toBe(0)
  })

  it('stages a ready update for the ordinary quit, once, and never for a stale one', async () => {
    const h = harness({ check: async () => compatibleInfo })
    h.updater.start()
    await settle()
    await h.updater.installOnQuit()
    expect(h.calls.stage).toBe(1)
    expect(h.calls.install).toBe(0)
    // Quit preparation and the explicit restart share one claim.
    await h.updater.installOnQuit()
    expect(await h.updater.restartToApply()).toBe(false)
    expect(h.calls.stage).toBe(1)

    const idle = harness()
    idle.updater.start()
    await settle()
    await idle.updater.installOnQuit()
    expect(idle.calls.stage).toBe(0)
  })

  it('a stale cached download is dropped at quit instead of staged', async () => {
    let localSchema = 24
    const timers = new ManualTimers()
    const calls = { stage: 0 }
    const updater = new AppUpdater({
      feed: {
        check: async () => compatibleInfo,
        download: async () => {},
        quitAndInstall: () => {},
        installOnQuit: async () => {
          calls.stage++
        }
      },
      currentVersion: '1.0.0',
      schemaVersion: 24,
      localSchemaVersion: () => localSchema,
      onStateChange: () => {},
      shutdown: async () => {},
      time: timers.time
    })
    updater.start()
    await settle()
    expect(updater.state().phase).toBe('ready')
    localSchema = 25
    await updater.installOnQuit()
    expect(calls.stage).toBe(0)
    expect(updater.state().phase).toBe('idle')
  })

  it('re-validates the cached download at install time', async () => {
    let localSchema = 24
    const timers = new ManualTimers()
    const calls = { install: 0 }
    const updater = new AppUpdater({
      feed: {
        check: async () => compatibleInfo,
        download: async () => {},
        quitAndInstall: () => {
          calls.install++
        },
        installOnQuit: async () => {}
      },
      currentVersion: '1.0.0',
      schemaVersion: 24,
      localSchemaVersion: () => localSchema,
      onStateChange: () => {},
      shutdown: async () => {},
      time: timers.time
    })
    updater.start()
    await settle()
    expect(updater.state().phase).toBe('ready')
    // The database moved after the download (a manual dogfood upgrade): the
    // stale cached update must not install.
    localSchema = 25
    expect(await updater.restartToApply()).toBe(false)
    expect(calls.install).toBe(0)
    expect(updater.state().phase).toBe('idle')
  })
})
