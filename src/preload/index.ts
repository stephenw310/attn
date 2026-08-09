import { contextBridge, ipcRenderer } from 'electron'
import type { AuthStatus } from '../shared/auth'

const api = {
  platform: process.platform,
  auth: {
    getStatus: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:getStatus'),
    signIn: (): Promise<AuthStatus> => ipcRenderer.invoke('auth:signIn')
  }
}

contextBridge.exposeInMainWorld('shc', api)

export type ShcApi = typeof api
