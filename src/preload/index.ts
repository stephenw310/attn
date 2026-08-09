import { contextBridge } from 'electron'

const api = {
  platform: process.platform
}

contextBridge.exposeInMainWorld('shc', api)

export type ShcApi = typeof api
