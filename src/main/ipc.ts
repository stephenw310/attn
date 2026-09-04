import {
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  type OpenDialogOptions,
  shell
} from 'electron'
import type { AiSettings } from '../shared/ai'
import type { AuthSignInResult, AuthStatus } from '../shared/auth'
import type { AppInfo, UpdateState } from '../shared/distribution'
import { INVOKE_CHANNEL_NAMES, type InvokeChannel, type InvokeChannels, IPC_CHANNELS } from '../shared/ipc'
import type { PendingFocusTarget } from '../shared/notifications'
import { type AppSettingUpdate, validateAppSettingUpdate } from '../shared/settings'
import { isThemePreference, type ThemePreference } from '../shared/theme'
import { fromAppFrame, MailFrameGrants } from './remoteImages'
import type { ServiceSupervisor } from './service/supervisor'

type Handler<K extends InvokeChannel> = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => InvokeChannels[K]['result'] | Promise<InvokeChannels[K]['result']>

export interface IpcContext {
  service: ServiceSupervisor
  authStatus: () => AuthStatus
  signIn: () => Promise<AuthSignInResult>
  setActiveAccount: (accountId: string) => Promise<AuthStatus>
  removeAccount: (accountId: string, deleteData: boolean) => Promise<AuthStatus>
  reorderAccounts: (accountIds: string[]) => Promise<AuthStatus>
  takePendingFocus: () => PendingFocusTarget | null
  acknowledgePendingFocus: (id: number) => void
  /** A renderer finished its pre-quit composer checkpoint (B28). */
  acknowledgeComposerCheckpoint: (requestId: number) => void
  /**
   * T33: register/unregister a mounted mail frame with the request filter.
   * `allowOnce` is minted here in main from the reader's `Load once` gesture
   * (`MailFrameGrants`); the registering renderer never asserts it.
   */
  registerMailFrame: (
    nonce: string,
    messageId: string,
    allowOnce: boolean
  ) => Promise<{ blocked: boolean; imagesAllowed: boolean }>
  unregisterMailFrame: (nonce: string) => void
  /** OS-side effects of a persisted settings write (login item, menu bar, badge). */
  applySettingEffects: (update: AppSettingUpdate) => void
  /** The About surface's version, schema, and build kind (F15). */
  appInfo: () => AppInfo
  /** T39 auto-update: absent updater answers idle / idle / false. */
  update: {
    getState: () => UpdateState
    check: () => Promise<UpdateState>
    restart: () => Promise<boolean>
  }
  /** T36 AI writing: key custody, gating, and streaming live in main. */
  ai: {
    getSettings: () => Promise<AiSettings>
    setSetting: (key: unknown, value: unknown) => Promise<AiSettings>
    setKey: (key: string) => Promise<AiSettings>
    deleteKey: () => Promise<AiSettings>
    generate: (request: unknown) => Promise<{ requestId: string }>
    cancel: (requestId: unknown) => void
  }
  setThemePreference: (preference: ThemePreference) => void
  pickAttachmentPaths?: () => Promise<string[]>
}

export function registerIpc(context: IpcContext): () => void {
  // Every channel main answers itself; the rest are forwarded to the utility
  // by the loop below, so registering here is what claims a channel.
  const mainOwned = new Set<InvokeChannel>()
  const handle = <K extends InvokeChannel>(channel: K, handler: Handler<K>): void => {
    mainOwned.add(channel)
    ipcMain.handle(channel, handler as Parameters<typeof ipcMain.handle>[1])
  }
  handle(IPC_CHANNELS.appGetInfo, () => context.appInfo())
  handle(IPC_CHANNELS.updateGetState, () => context.update.getState())
  handle(IPC_CHANNELS.updateCheck, () => context.update.check())
  handle(IPC_CHANNELS.updateRestart, () => context.update.restart())
  handle(IPC_CHANNELS.aiGetSettings, () => context.ai.getSettings())
  handle(IPC_CHANNELS.aiSetSetting, (_event, key, value) => context.ai.setSetting(key, value))
  handle(IPC_CHANNELS.aiSetKey, (_event, key) => {
    if (typeof key !== 'string' || key.trim().length === 0 || key.length > 2_048) {
      throw new Error('invalid AI provider key')
    }
    return context.ai.setKey(key.trim())
  })
  handle(IPC_CHANNELS.aiDeleteKey, () => context.ai.deleteKey())
  handle(IPC_CHANNELS.aiGenerate, (_event, request) => context.ai.generate(request))
  handle(IPC_CHANNELS.aiCancel, (_event, requestId) => {
    context.ai.cancel(requestId)
    return undefined
  })
  handle(IPC_CHANNELS.authGetStatus, () => context.authStatus())
  handle(IPC_CHANNELS.authSignIn, () => context.signIn())
  handle(IPC_CHANNELS.accountsSetActive, (_event, accountId) => {
    if (typeof accountId !== 'string' || accountId.length === 0) throw new Error('invalid account id')
    return context.setActiveAccount(accountId)
  })
  handle(IPC_CHANNELS.accountsRemove, (_event, accountId, deleteData) => {
    if (typeof accountId !== 'string' || accountId.length === 0) throw new Error('invalid account id')
    if (typeof deleteData !== 'boolean') throw new Error('invalid local-data choice')
    return context.removeAccount(accountId, deleteData)
  })
  handle(IPC_CHANNELS.accountsReorder, (_event, accountIds) => {
    if (
      !Array.isArray(accountIds) ||
      !accountIds.every((id): id is string => typeof id === 'string' && id.length > 0)
    ) {
      throw new Error('invalid account order')
    }
    return context.reorderAccounts(accountIds)
  })
  handle(IPC_CHANNELS.settingsSetTheme, (_event, preference) => {
    if (!isThemePreference(preference)) throw new Error('invalid theme preference')
    context.setThemePreference(preference)
    return context.service.invoke(IPC_CHANNELS.settingsSetTheme, preference)
  })
  handle(IPC_CHANNELS.settingsSet, async (_event, key, value) => {
    // Validate before forwarding so OS effects only ever follow a write the
    // utility will accept; the utility re-validates before touching SQLite.
    const update = validateAppSettingUpdate(key, value)
    const settings = await context.service.invoke(IPC_CHANNELS.settingsSet, update.key, update.value)
    context.applySettingEffects(update)
    return settings
  })
  handle(IPC_CHANNELS.draftCheckpointDone, (_event, requestId) => {
    if (typeof requestId !== 'number' || !Number.isFinite(requestId)) {
      throw new Error('invalid checkpoint id')
    }
    context.acknowledgeComposerCheckpoint(requestId)
    return undefined
  })
  handle(IPC_CHANNELS.mailAcknowledgePendingFocus, (_event, id) => {
    if (typeof id !== 'number' || !Number.isFinite(id)) throw new Error('invalid focus id')
    context.acknowledgePendingFocus(id)
    return undefined
  })
  const isFrameNonce = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-z0-9-]{8,64}$/i.test(value)
  const isMessageId = (value: unknown): value is string =>
    typeof value === 'string' && value.length > 0 && value.length <= 256
  // T33: main keeps the one-shot allowance. Registration reports where a
  // frame is mounted and carries no policy; the gesture channel records a
  // single-use grant against the nonce about to register. The gesture itself
  // is renderer-reported user intent, like `Always load from sender` — main
  // cannot see a click — so the only origin evidence it checks is that the
  // call came from the app frame, never from a mail frame.
  const assertAppFrame = (event: Parameters<Parameters<typeof handle>[1]>[0]): void => {
    if (!fromAppFrame(event)) throw new Error('remote-image grants come from the app frame only')
  }
  const mailFrameGrants = new MailFrameGrants()
  handle(IPC_CHANNELS.mailAllowRemoteImagesOnce, (event, nonce, messageId) => {
    assertAppFrame(event)
    if (!isFrameNonce(nonce)) throw new Error('invalid frame nonce')
    if (!isMessageId(messageId)) throw new Error('invalid message id')
    mailFrameGrants.allowOnceFor(nonce, messageId)
    return undefined
  })
  handle(IPC_CHANNELS.mailRegisterMessageFrame, (event, nonce, messageId) => {
    assertAppFrame(event)
    if (!isFrameNonce(nonce)) throw new Error('invalid frame nonce')
    if (!isMessageId(messageId)) throw new Error('invalid message id')
    return context.registerMailFrame(nonce, messageId, mailFrameGrants.take(nonce, messageId))
  })
  handle(IPC_CHANNELS.mailUnregisterMessageFrame, (_event, nonce) => {
    if (!isFrameNonce(nonce)) throw new Error('invalid frame nonce')
    context.unregisterMailFrame(nonce)
    return undefined
  })
  handle(IPC_CHANNELS.draftPickAttachments, async (event, id) => {
    let paths: string[]
    if (context.pickAttachmentPaths) paths = await context.pickAttachmentPaths()
    else {
      const options: OpenDialogOptions = {
        properties: ['openFile', 'multiSelections'],
        title: 'Attach files'
      }
      const parent = BrowserWindow.fromWebContents(event.sender)
      paths = (await (parent ? dialog.showOpenDialog(parent, options) : dialog.showOpenDialog(options)))
        .filePaths
    }
    // The dialog is main's half; spooling is the shared utility handler.
    return context.service.invoke(IPC_CHANNELS.draftAddAttachments, id, paths)
  })
  handle(IPC_CHANNELS.mailDownloadAttachment, async (_event, request) => {
    const result = await context.service.invoke(IPC_CHANNELS.mailDownloadAttachment, request)
    if ('path' in result) shell.showItemInFolder(result.path)
    return result
  })
  // A window that mounts after the utility stopped for good seeds its sync
  // banner from this read. Forwarding it would reject and leave that window
  // showing an idle, healthy-looking status for a service that is gone.
  handle(IPC_CHANNELS.syncGetState, () => {
    const terminal = context.service.terminalState()
    return terminal ?? context.service.invoke(IPC_CHANNELS.syncGetState)
  })
  handle(IPC_CHANNELS.mailTakePendingFocus, () => context.takePendingFocus())
  for (const channel of INVOKE_CHANNEL_NAMES) {
    if (mainOwned.has(channel)) continue
    ipcMain.handle(channel, (_event, ...args) => context.service.invoke(channel, ...args))
  }
  return () => {
    for (const channel of INVOKE_CHANNEL_NAMES) ipcMain.removeHandler(channel)
  }
}
