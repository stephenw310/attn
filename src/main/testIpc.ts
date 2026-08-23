import { ipcMain } from 'electron'
import { errorMessage } from '../shared/error'
import { nonEmptyString } from '../shared/guards'
import { TEST_CHANNELS } from '../shared/ipc'
import type { ServiceSupervisor } from './service/supervisor'

export interface TestSeamDeps {
  service: () => ServiceSupervisor | null
  focusInboxThread: (threadId: string) => void
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
    ipcMain.on(TEST_CHANNELS.focusThread, (_event, threadId: unknown) => {
      if (nonEmptyString(threadId)) this.deps.focusInboxThread(threadId)
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
      TEST_CHANNELS.setUndoSendDelay
    ]) {
      ipcMain.on(channel, (_event, ...args: unknown[]) => {
        void this.forward(channel, args).catch((error) => {
          console.error(`[test] ${channel} failed: ${errorMessage(error)}`)
        })
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
    ipcMain.on(TEST_CHANNELS.utilityState, (_event, ids: unknown, done?: (result: unknown) => void) => {
      void this.forward(TEST_CHANNELS.utilityState, [ids])
        .then((result) => done?.(result))
        .catch((error) => done?.({ error: errorMessage(error) }))
    })
    ipcMain.on(
      TEST_CHANNELS.listMailboxThreadIds,
      (_event, mailbox: unknown, done?: (threadIds: string[], error?: string) => void) => {
        void this.forward(TEST_CHANNELS.listMailboxThreadIds, [mailbox])
          .then((result) => done?.(result as string[]))
          .catch((error) => done?.([], errorMessage(error)))
      }
    )
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
