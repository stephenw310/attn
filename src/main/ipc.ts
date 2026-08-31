import {
  BrowserWindow,
  dialog,
  type IpcMainInvokeEvent,
  ipcMain,
  type OpenDialogOptions,
  shell
} from 'electron'
import type { AuthSignInResult, AuthStatus } from '../shared/auth'
import { INVOKE_CHANNEL_NAMES, type InvokeChannel, type InvokeChannels, IPC_CHANNELS } from '../shared/ipc'
import type { PendingFocusTarget } from '../shared/notifications'
import { type AppSettingUpdate, validateAppSettingUpdate } from '../shared/settings'
import { isThemePreference, type ThemePreference } from '../shared/theme'
import type { ServiceSupervisor } from './service/supervisor'

type Handler<K extends InvokeChannel> = (
  event: IpcMainInvokeEvent,
  ...args: unknown[]
) => InvokeChannels[K]['result'] | Promise<InvokeChannels[K]['result']>

function handle<K extends InvokeChannel>(channel: K, handler: Handler<K>): void {
  ipcMain.handle(channel, handler as Parameters<typeof ipcMain.handle>[1])
}

export interface IpcContext {
  service: ServiceSupervisor
  authStatus: () => AuthStatus
  signIn: () => Promise<AuthSignInResult>
  setActiveAccount: (accountId: string) => Promise<AuthStatus>
  removeAccount: (accountId: string, deleteData: boolean) => Promise<AuthStatus>
  reorderAccounts: (accountIds: string[]) => Promise<AuthStatus>
  takePendingFocus: () => PendingFocusTarget | null
  acknowledgePendingFocus: (id: number) => void
  /** T33: register/unregister a mounted mail frame with the request filter. */
  registerMailFrame: (
    nonce: string,
    messageId: string,
    allowOnce: boolean
  ) => Promise<{ blocked: boolean; imagesAllowed: boolean }>
  unregisterMailFrame: (nonce: string) => void
  /** OS-side effects of a persisted settings write (login item, menu bar). */
  applySettingEffects: (update: AppSettingUpdate) => void
  setThemePreference: (preference: ThemePreference) => void
  pickAttachmentPaths?: () => Promise<string[]>
}

export function registerIpc(context: IpcContext): () => void {
  const mainOwned = new Set<InvokeChannel>([
    IPC_CHANNELS.authGetStatus,
    IPC_CHANNELS.authSignIn,
    IPC_CHANNELS.accountsSetActive,
    IPC_CHANNELS.accountsRemove,
    IPC_CHANNELS.accountsReorder,
    IPC_CHANNELS.draftPickAttachments,
    IPC_CHANNELS.mailDownloadAttachment,
    IPC_CHANNELS.mailTakePendingFocus,
    IPC_CHANNELS.mailAcknowledgePendingFocus,
    IPC_CHANNELS.mailRegisterMessageFrame,
    IPC_CHANNELS.mailUnregisterMessageFrame,
    IPC_CHANNELS.settingsSetTheme,
    IPC_CHANNELS.settingsSet,
    IPC_CHANNELS.syncGetState
  ])
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
  handle(IPC_CHANNELS.mailAcknowledgePendingFocus, (_event, id) => {
    if (typeof id !== 'number' || !Number.isFinite(id)) throw new Error('invalid focus id')
    context.acknowledgePendingFocus(id)
    return undefined
  })
  const isFrameNonce = (value: unknown): value is string =>
    typeof value === 'string' && /^[a-z0-9-]{8,64}$/i.test(value)
  handle(IPC_CHANNELS.mailRegisterMessageFrame, (_event, nonce, messageId, allowOnce) => {
    if (!isFrameNonce(nonce)) throw new Error('invalid frame nonce')
    if (typeof messageId !== 'string' || messageId.length === 0 || messageId.length > 256) {
      throw new Error('invalid message id')
    }
    if (typeof allowOnce !== 'boolean') throw new Error('invalid allow-once flag')
    return context.registerMailFrame(nonce, messageId, allowOnce)
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
    return context.service.invoke(IPC_CHANNELS.draftPickAttachments, id, paths)
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
    handle(channel, (_event, ...args) => context.service.invoke(channel, ...args))
  }
  return () => {
    for (const channel of INVOKE_CHANNEL_NAMES) ipcMain.removeHandler(channel)
  }
}
