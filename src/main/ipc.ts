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
import type { PendingFocus } from './notify'
import { takePendingFocus } from './notify'
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
  signOut: () => AuthStatus
  pendingFocus: () => PendingFocus | null
  clearPendingFocus: () => void
  pickAttachmentPaths?: () => Promise<string[]>
}

export function registerIpc(context: IpcContext): () => void {
  const mainOwned = new Set<InvokeChannel>([
    IPC_CHANNELS.authGetStatus,
    IPC_CHANNELS.authSignIn,
    IPC_CHANNELS.authSignOut,
    IPC_CHANNELS.draftPickAttachments,
    IPC_CHANNELS.mailDownloadAttachment,
    IPC_CHANNELS.mailTakePendingFocus,
    IPC_CHANNELS.syncGetState
  ])
  handle(IPC_CHANNELS.authGetStatus, () => context.authStatus())
  handle(IPC_CHANNELS.authSignIn, () => context.signIn())
  handle(IPC_CHANNELS.authSignOut, () => context.signOut())
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
  handle(IPC_CHANNELS.mailTakePendingFocus, () => {
    const threadId = takePendingFocus(context.pendingFocus())
    context.clearPendingFocus()
    return threadId
  })
  for (const channel of INVOKE_CHANNEL_NAMES) {
    if (mainOwned.has(channel)) continue
    handle(channel, (_event, ...args) => context.service.invoke(channel, ...args))
  }
  return () => {
    for (const channel of INVOKE_CHANNEL_NAMES) ipcMain.removeHandler(channel)
  }
}
