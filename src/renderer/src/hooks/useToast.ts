import { useCallback, useRef, useState } from 'react'

export interface ToastState {
  id: number
  message: string
}

export function useToast(): [ToastState | null, (message: string, durationMs?: number) => void] {
  const [toast, setToast] = useState<ToastState | null>(null)
  const tokenRef = useRef(0)

  const showToast = useCallback((message: string, durationMs = 4_000) => {
    const token = ++tokenRef.current
    setToast({ id: token, message })
    window.setTimeout(() => {
      if (tokenRef.current === token) setToast(null)
    }, durationMs)
  }, [])

  return [toast, showToast]
}
