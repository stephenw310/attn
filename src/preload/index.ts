import { contextBridge, ipcRenderer } from 'electron'
import type { TriageAction, TriageResult } from '../shared/actions'
import type { AuthStatus } from '../shared/auth'
import type { Conversation, SyncState, ThreadRow } from '../shared/mail'

const api = {
  platform: process.platform,
  auth: {
    getStatus: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:getStatus'),
    signIn: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:signIn'),
    signOut: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:signOut')
  },
  mail: {
    listThreads: (): Promise<ThreadRow[]> => ipcRenderer.invoke('mail:listThreads'),
    getUnreadCount: (): Promise<number> => ipcRenderer.invoke('mail:getUnreadCount'),
    getConversation: (threadId: string): Promise<Conversation | null> =>
      ipcRenderer.invoke('mail:getConversation', threadId),
    triage: (action: TriageAction): Promise<TriageResult> => ipcRenderer.invoke('mail:triage', action),
    markReadOnOpen: (threadId: string): Promise<void> => ipcRenderer.invoke('mail:markReadOnOpen', threadId),
    undo: (): Promise<TriageResult | null> => ipcRenderer.invoke('mail:undo'),
    getPendingActionCount: (): Promise<number> => ipcRenderer.invoke('mail:getPendingActionCount'),
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

contextBridge.exposeInMainWorld('attn', api)

export type AttnApi = typeof api
