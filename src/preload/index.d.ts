import type { ShcApi } from './index'

declare global {
  interface Window {
    shc: ShcApi
  }
}

export {}
