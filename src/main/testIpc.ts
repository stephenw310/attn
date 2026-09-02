import { ipcMain } from 'electron'
import { errorMessage } from '../shared/error'
import { nonEmptyString } from '../shared/guards'
import { TEST_CHANNELS } from '../shared/ipc'
import type { UpdatePhase, UpdateState } from '../shared/update'
import type { AiManager, FakeAiScript } from './ai/manager'
import type { ServiceSupervisor } from './service/supervisor'

export interface TestSeamDeps {
  service: () => ServiceSupervisor | null
  ai: () => AiManager | null
  focusInboxThread: (threadId: string | null, accountId?: string) => void
  /** T39: makes update:getState answer a fixed state (null clears the override). */
  setUpdateStateOverride: (state: UpdateState | null) => void
}

const UPDATE_PHASES: readonly UpdatePhase[] = ['idle', 'checking', 'downloading', 'ready']

function parseUpdateState(value: unknown): UpdateState | null {
  if (!value || typeof value !== 'object') return null
  const state = value as { phase?: unknown; readyVersion?: unknown }
  if (!UPDATE_PHASES.includes(state.phase as UpdatePhase)) return null
  if (state.readyVersion !== null && typeof state.readyVersion !== 'string') return null
  return { phase: state.phase as UpdatePhase, readyVersion: state.readyVersion as string | null }
}

export class TestSeams {
  private attachmentPickerPaths: string[] | null = null

  constructor(
    private readonly enabled: boolean,
    private readonly deps: TestSeamDeps
  ) {}

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
    for (const channel of [TEST_CHANNELS.installSendProvider, TEST_CHANNELS.runHistoryCycle]) {
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
      TEST_CHANNELS.queryPerfStats
    ]) {
      ipcMain.on(channel, (_event, request: unknown, done?: (result: unknown) => void) => {
        void this.forward(channel, [request])
          .then((result) => done?.(result))
          .catch((error) => done?.({ error: errorMessage(error) }))
      })
    }
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
    // T36: the fake AI provider lives in main's AiManager, not the utility —
    // that is where the real transport (and its gating) runs.
    ipcMain.on(
      TEST_CHANNELS.installFakeAiProvider,
      (_event, script: unknown, done?: (error?: string) => void) => {
        const manager = this.deps.ai()
        if (!manager) {
          done?.('AI manager unavailable')
          return
        }
        manager.installFakeProvider((script ?? {}) as FakeAiScript)
        done?.()
      }
    )
    ipcMain.on(TEST_CHANNELS.aiProviderRequests, (_event, done?: (result: unknown) => void) => {
      done?.(this.deps.ai()?.fakeProviderRequests() ?? [])
    })
    // T39: no updater exists under the harness, so the initial-read path of
    // the renderer's ready announcement needs a stored state to find.
    ipcMain.on(TEST_CHANNELS.setUpdateState, (_event, state: unknown, done?: Done) => {
      this.deps.setUpdateStateOverride(parseUpdateState(state))
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
