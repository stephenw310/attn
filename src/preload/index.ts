import { contextBridge, ipcRenderer } from 'electron'
import type { AuthStatus } from '../shared/auth'
import type { Conversation, SyncState, ThreadRow } from '../shared/mail'

const api = {
  platform: process.platform,
  auth: {
    getStatus: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:getStatus'),
    signIn: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:signIn')
  },
  mail: {
    listThreads: (): Promise<ThreadRow[]> => ipcRenderer.invoke('mail:listThreads'),
    getConversation: (threadId: string): Promise<Conversation | null> =>
      ipcRenderer.invoke('mail:getConversation', threadId),
    onChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on('mail:changed', listener)
      return () => ipcRenderer.removeListener('mail:changed', listener)
    }
  },
  sync: {
    getState: (): Promise<SyncState> => ipcRenderer.invoke('sync:getState'),
    onState: (cb: (s: SyncState) => void): (() => void) => {
      const listener = (_e: unknown, s: SyncState): void => cb(s)
      ipcRenderer.on('sync:state', listener)
      return () => ipcRenderer.removeListener('sync:state', listener)
    }
  }
}

contextBridge.exposeInMainWorld('shc', api)

export type ShcApi = typeof api
