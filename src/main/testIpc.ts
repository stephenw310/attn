import { ipcMain } from 'electron'
import type { UpdateCheck, UpdateCheckOutcome, UpdatePhase, UpdateState } from '../shared/distribution'
import { errorMessage } from '../shared/error'
import { nonEmptyString } from '../shared/guards'
import { TEST_CHANNELS } from '../shared/ipc'
import { type FakeAiScript, FakeAiTransport } from './ai/fakeTransport'
import type { ServiceSupervisor } from './service/supervisor'

export interface TestSeamDeps {
  service: () => ServiceSupervisor | null
  focusInboxThread: (threadId: string | null, accountId?: string) => void
  /** T39: makes update:getState answer a fixed state (null clears the override). */
  setUpdateStateOverride: (state: UpdateState | null) => void
}

const UPDATE_PHASES: readonly UpdatePhase[] = ['idle', 'checking', 'downloading', 'ready']
const UPDATE_OUTCOMES: readonly UpdateCheckOutcome[] = ['up-to-date', 'available', 'incompatible', 'error']

function parseUpdateCheck(value: unknown): UpdateCheck | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== 'object') return undefined
  const check = value as { at?: unknown; outcome?: unknown; version?: unknown }
  if (typeof check.at !== 'number' || !UPDATE_OUTCOMES.includes(check.outcome as UpdateCheckOutcome)) {
    return undefined
  }
  if (check.version !== null && check.version !== undefined && typeof check.version !== 'string') {
    return undefined
  }
  return { at: check.at, outcome: check.outcome as UpdateCheckOutcome, version: check.version ?? null }
}

function parseUpdateState(value: unknown): UpdateState | null {
  if (!value || typeof value !== 'object') return null
  const state = value as { phase?: unknown; readyVersion?: unknown; lastCheck?: unknown }
  if (!UPDATE_PHASES.includes(state.phase as UpdatePhase)) return null
  if (state.readyVersion !== null && typeof state.readyVersion !== 'string') return null
  const lastCheck = parseUpdateCheck(state.lastCheck)
  if (lastCheck === undefined) return null
  return { phase: state.phase as UpdatePhase, readyVersion: state.readyVersion as string | null, lastCheck }
}

export class TestSeams {
  /**
   * The scripted AI provider (T36). Main hands its `fetch` to the AiManager
   * under the seam, so the production transport is the only one that ever
   * runs — there is no fake inside the manager (REF-6).
   */
  readonly aiTransport = new FakeAiTransport()
  private attachmentPickerPaths: string[] | null = null

  private armedHoldChannel: string | null = null
  private releaseHeld: (() => void) | null = null
  /** Every invoke listener main registered, by channel (see `wrapInvokeHandlers`). */
  private readonly invokeHandlers = new Map<string, InvokeListener>()
  /** Channels whose calls are being recorded, with the args each call carried. */
  private readonly observedInvokes = new Map<string, unknown[][]>()
  private failNextInvoke: { channel: string; args?: unknown[]; message: string } | null = null

  constructor(
    private readonly enabled: boolean,
    private readonly deps: TestSeamDeps
  ) {
    if (enabled) this.wrapInvokeHandlers()
  }

  /**
   * T4: hold one invoke result after main computed it, so a spec can
   * interleave a competing action without a sleep. Every invoke channel is
   * claimed through `ipcMain.handle` — `registerIpc` uses its own `handle()`
   * wrapper for the channels main answers and the same call in the loop that
   * forwards the rest — so wrapping that one public method reaches them all.
   * The alternative, a spec swapping handlers through Electron's private
   * `_invokeHandlers`, breaks with no compile-time signal on an Electron bump.
   * Installed from the constructor because `registerIpc` runs before
   * `register()`, and only under the test-user-data seam.
   */
  private wrapInvokeHandlers(): void {
    const handle = ipcMain.handle.bind(ipcMain)
    ipcMain.handle = (channel, listener) => {
      this.invokeHandlers.set(channel, listener)
      handle(channel, async (event, ...args) => {
        this.observedInvokes.get(channel)?.push(args)
        const hold = this.armedHoldChannel === channel
        if (hold) this.armedHoldChannel = null
        const fail = this.failNextInvoke?.channel === channel ? this.failNextInvoke : null
        if (fail) this.failNextInvoke = null
        const result = await listener(event, ...(fail?.args ?? args))
        if (hold) {
          await new Promise<void>((resolve) => {
            this.releaseHeld = resolve
          })
        }
        // A handler that half-succeeded and then rejected: the substituted
        // arguments decide how far the real work got before the failure.
        if (fail) throw new Error(fail.message)
        return result
      })
    }
  }

  takeAttachmentPickerPaths(): string[] {
    const paths = this.attachmentPickerPaths ?? []
    this.attachmentPickerPaths = null
    return paths
  }

  register(): void {
    if (!this.enabled) return
    ipcMain.on(TEST_CHANNELS.focusThread, (_event, threadId: unknown, accountId: unknown) => {
      // Models a notification click: a thread target, or an accountId-only
      // summary click that lands on that account's inbox (F12/F18).
      const account = nonEmptyString(accountId) ? accountId : undefined
      if (nonEmptyString(threadId)) this.deps.focusInboxThread(threadId, account)
      else if (threadId === null && account) this.deps.focusInboxThread(null, account)
    })
    ipcMain.on(TEST_CHANNELS.setSearchWindow, (_event, limit: unknown, done?: Done) => {
      this.forwardDone(TEST_CHANNELS.setSearchWindow, [limit], done)
    })
    ipcMain.on(TEST_CHANNELS.setAttachmentPickerFiles, (_event, paths: unknown) => {
      this.attachmentPickerPaths = Array.isArray(paths)
        ? paths.filter((path): path is string => typeof path === 'string')
        : []
    })
    ipcMain.on(TEST_CHANNELS.reloadSeed, (_event, labelsOrDone: unknown, maybeDone?: Done) => {
      const done = typeof labelsOrDone === 'function' ? (labelsOrDone as Done) : maybeDone
      const args = typeof labelsOrDone === 'function' ? [] : [labelsOrDone]
      this.forwardDone(TEST_CHANNELS.reloadSeed, args, done)
    })
    for (const channel of [
      TEST_CHANNELS.deleteThread,
      TEST_CHANNELS.updateMessageBody,
      TEST_CHANNELS.setSendAsSignature,
      TEST_CHANNELS.markDraftMirrored,
      TEST_CHANNELS.failOutbox,
      TEST_CHANNELS.remoteDraft
    ]) {
      ipcMain.on(channel, (_event, ...raw: unknown[]) => {
        const done = typeof raw.at(-1) === 'function' ? (raw.pop() as Done) : undefined
        this.forwardDone(channel, raw, done)
      })
    }
    for (const channel of [
      TEST_CHANNELS.setSyncState,
      TEST_CHANNELS.delayConversation,
      TEST_CHANNELS.delayDraftReopen,
      TEST_CHANNELS.delayDraftInlineImage,
      TEST_CHANNELS.failNextDraftSave,
      TEST_CHANNELS.failNextAction,
      TEST_CHANNELS.failNextActionAuth,
      TEST_CHANNELS.delaySetActiveAccount,
      TEST_CHANNELS.setUndoSendDelay
    ]) {
      ipcMain.on(channel, (_event, ...args: unknown[]) => {
        void this.forward(channel, args).catch((error) => {
          console.error(`[test] ${channel} failed: ${errorMessage(error)}`)
        })
      })
    }
    // Smart splits run in the utility, so their seams forward there. The fake
    // TypeSafe transport is installed on the utility's own seam object, which
    // owns one from construction: under ATTN_TEST_USER_DATA no triage request
    // can reach the network whether or not a spec installed a script.
    for (const channel of [
      TEST_CHANNELS.installSendProvider,
      TEST_CHANNELS.runHistoryCycle,
      TEST_CHANNELS.installFakeTriageProvider,
      TEST_CHANNELS.runTriagePass
    ]) {
      ipcMain.on(channel, (_event, request: unknown, done?: (error?: string) => void) => {
        void this.forward(channel, [request])
          .then(() => done?.())
          .catch((error) => done?.(errorMessage(error)))
      })
    }
    ipcMain.on(
      TEST_CHANNELS.runLifetimeSweep,
      (_event, request: unknown, done?: (result: unknown) => void) => {
        void this.forward(TEST_CHANNELS.runLifetimeSweep, [request])
          .then((result) => done?.(result))
          .catch((error) => done?.({ cursor: null, error: errorMessage(error), formats: [], pageTokens: [] }))
      }
    )
    ipcMain.on(
      TEST_CHANNELS.runExistenceSweep,
      (_event, request: unknown, done?: (result: unknown) => void) => {
        void this.forward(TEST_CHANNELS.runExistenceSweep, [request])
          .then((result) => done?.(result))
          .catch((error) => done?.({ error: errorMessage(error) }))
      }
    )
    for (const channel of [
      TEST_CHANNELS.runFtsBackfill,
      TEST_CHANNELS.searchIndexStats,
      TEST_CHANNELS.queryPerfStats,
      TEST_CHANNELS.triageRequests
    ]) {
      ipcMain.on(channel, (_event, request: unknown, done?: (result: unknown) => void) => {
        void this.forward(channel, [request])
          .then((result) => done?.(result))
          .catch((error) => done?.({ error: errorMessage(error) }))
      })
    }
    ipcMain.on(
      TEST_CHANNELS.expireReminders,
      (_event, expected: unknown, done?: (result: unknown) => void) => {
        void this.forward(TEST_CHANNELS.expireReminders, [expected])
          .then((count) => done?.(count))
          .catch((error) => done?.({ error: errorMessage(error) }))
      }
    )
    ipcMain.on(TEST_CHANNELS.utilityState, (_event, ids: unknown, done?: (result: unknown) => void) => {
      void this.forward(TEST_CHANNELS.utilityState, [ids])
        .then((result) => done?.(result))
        .catch((error) => done?.({ error: errorMessage(error) }))
    })
    ipcMain.on(
      TEST_CHANNELS.accountDataStats,
      (_event, accountId: unknown, done?: (result: unknown) => void) => {
        void this.forward(TEST_CHANNELS.accountDataStats, [accountId])
          .then((result) => done?.(result))
          .catch((error) => done?.({ error: errorMessage(error) }))
      }
    )
    ipcMain.on(
      TEST_CHANNELS.listMailboxThreadIds,
      (_event, mailbox: unknown, done?: (threadIds: string[], error?: string) => void) => {
        void this.forward(TEST_CHANNELS.listMailboxThreadIds, [mailbox])
          .then((result) => done?.(result as string[]))
          .catch((error) => done?.([], errorMessage(error)))
      }
    )
    // T36: the fake provider replaces main's HTTP transport, not the
    // AiManager — that is where the real gating, streaming and cancellation
    // run, and the harness must exercise them.
    ipcMain.on(
      TEST_CHANNELS.installFakeAiProvider,
      (_event, script: unknown, done?: (error?: string) => void) => {
        this.aiTransport.install((script ?? {}) as FakeAiScript)
        done?.()
      }
    )
    ipcMain.on(TEST_CHANNELS.aiProviderRequests, (_event, done?: (result: unknown) => void) => {
      done?.(this.aiTransport.recorded())
    })
    // T39: no updater exists under the harness, so the initial-read path of
    // the renderer's ready announcement needs a stored state to find.
    ipcMain.on(TEST_CHANNELS.setUpdateState, (_event, state: unknown, done?: Done) => {
      this.deps.setUpdateStateOverride(parseUpdateState(state))
      done?.()
    })
    // Arm the next result on a channel to park ('arm'), let a parked one
    // through ('release'), or report whether one is parked ('status').
    ipcMain.on(TEST_CHANNELS.holdNextResponse, (_event, request: unknown, done?: (held: boolean) => void) => {
      const { action, channel } = (request ?? {}) as { action?: string; channel?: string }
      if (action === 'arm') this.armedHoldChannel = nonEmptyString(channel) ? channel : null
      else if (action === 'release') {
        this.releaseHeld?.()
        this.releaseHeld = null
      }
      done?.(this.releaseHeld !== null)
    })
    // Record the arguments of every invoke on a channel, so a spec can assert
    // what the renderer asked main for (or that it asked nothing at all)
    // without swapping handlers through Electron's private map.
    ipcMain.on(TEST_CHANNELS.observeInvokes, (_event, request: unknown, done?: (calls: unknown) => void) => {
      const { action, channel } = (request ?? {}) as { action?: string; channel?: string }
      if (!nonEmptyString(channel)) {
        done?.([])
        return
      }
      if (action === 'watch') this.observedInvokes.set(channel, [])
      else if (action === 'stop') this.observedInvokes.delete(channel)
      done?.(this.observedInvokes.get(channel) ?? [])
    })
    // Call a registered handler straight from main — a request whose result
    // no renderer subscription is waiting for (the T32 adversarial pull).
    ipcMain.on(TEST_CHANNELS.invokeHandler, (_event, request: unknown, done?: (result: unknown) => void) => {
      const { channel, args } = (request ?? {}) as { channel?: string; args?: unknown[] }
      const listener = nonEmptyString(channel) ? this.invokeHandlers.get(channel) : undefined
      if (!listener) {
        done?.({ error: `no handler for ${channel}` })
        return
      }
      void Promise.resolve(listener({} as Parameters<InvokeListener>[0], ...(args ?? [])))
        .then((value) => done?.({ value }))
        .catch((error) => done?.({ error: errorMessage(error) }))
    })
    // Make the next invoke on a channel reject after its real handler ran —
    // optionally with substituted arguments, which is how a spec models work
    // that partly landed before the failure.
    ipcMain.on(TEST_CHANNELS.failNextInvoke, (_event, request: unknown, done?: Done) => {
      const { channel, args, message } = (request ?? {}) as {
        channel?: string
        args?: unknown[]
        message?: string
      }
      if (!nonEmptyString(channel)) {
        done?.('missing channel')
        return
      }
      this.failNextInvoke = {
        channel,
        ...(Array.isArray(args) ? { args } : {}),
        message: nonEmptyString(message) ? message : 'Simulated handler failure'
      }
      done?.()
    })
    ipcMain.on(TEST_CHANNELS.crashUtility, (_event, done?: (error?: string) => void) => {
      void this.deps
        .service()
        ?.crashForTest()
        .then(() => done?.())
        .catch((error) => done?.(errorMessage(error)))
    })
  }

  dispose(): void {
    for (const channel of Object.values(TEST_CHANNELS)) ipcMain.removeAllListeners(channel)
    this.attachmentPickerPaths = null
    this.armedHoldChannel = null
    this.releaseHeld?.()
    this.releaseHeld = null
    this.observedInvokes.clear()
    this.failNextInvoke = null
  }

  private forward(channel: string, args: unknown[]): Promise<unknown> {
    const service = this.deps.service()
    if (!service) return Promise.reject(new Error('utility unavailable'))
    return service.internal('test', channel, ...args)
  }

  private forwardDone(channel: string, args: unknown[], done?: Done): void {
    void this.forward(channel, args)
      .then(() => done?.())
      .catch((error) => done?.(errorMessage(error)))
  }
}

type Done = (error?: string) => void

type InvokeListener = Parameters<typeof ipcMain.handle>[1]
