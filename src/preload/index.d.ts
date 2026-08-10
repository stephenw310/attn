import type { AttnApi } from './index'

declare global {
  interface Window {
    attn: AttnApi
  }
}

export {}
