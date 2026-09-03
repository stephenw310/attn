import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_TOAST_DURATION_MS } from '../tuning'

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
  const timersRef = useRef(new Set<number>())

  // Every toast schedules its own dismissal; unmounting (an account switch
  // remounts the shell) must not leave those timers to fire into a dead tree.
  useEffect(() => {
    const timers = timersRef.current
    return () => {
      for (const timer of timers) window.clearTimeout(timer)
      timers.clear()
    }
  }, [])

  const showToast = useCallback<ShowToast>(
    (message, options = DEFAULT_TOAST_DURATION_MS) =>
      new Promise<void>((resolve) => {
        const now = Date.now()
        const normalized = typeof options === 'number' ? { durationMs: options } : options
        const expiresAt = normalized.expiresAt ?? now + (normalized.durationMs ?? DEFAULT_TOAST_DURATION_MS)
        const durationMs = Math.max(0, expiresAt - now)
        const token = ++tokenRef.current
        setToast({ id: token, message, durationMs, expiresAt, countdown: normalized.countdown ?? false })
        const timer = window.setTimeout(() => {
          timersRef.current.delete(timer)
          if (tokenRef.current === token) setToast(null)
          resolve()
        }, durationMs)
        timersRef.current.add(timer)
      }),
    []
  )

  return [toast, showToast]
}
