import { useCallback, useRef, useState } from 'react'

export interface ToastState {
  id: number
  message: string
  durationMs: number
  expiresAt: number
  countdown: boolean
}

export interface ToastOptions {
  durationMs?: number
  expiresAt?: number
  countdown?: boolean
}

export type ShowToast = (message: string, options?: number | ToastOptions) => Promise<void>

export function useToast(): [ToastState | null, ShowToast] {
  const [toast, setToast] = useState<ToastState | null>(null)
  const tokenRef = useRef(0)

  const showToast = useCallback<ShowToast>(
    (message, options = 4_000) =>
      new Promise<void>((resolve) => {
        const now = Date.now()
        const normalized = typeof options === 'number' ? { durationMs: options } : options
        const expiresAt = normalized.expiresAt ?? now + (normalized.durationMs ?? 4_000)
        const durationMs = Math.max(0, expiresAt - now)
        const token = ++tokenRef.current
        setToast({ id: token, message, durationMs, expiresAt, countdown: normalized.countdown ?? false })
        window.setTimeout(() => {
          if (tokenRef.current === token) setToast(null)
          resolve()
        }, durationMs)
      }),
    []
  )

  return [toast, showToast]
}
