import { useCallback, useRef, useState } from 'react'

export interface ToastState {
  id: number
  message: string
}

export function useToast(): [ToastState | null, (message: string) => Promise<void>] {
  const [toast, setToast] = useState<ToastState | null>(null)
  const tokenRef = useRef(0)

  const showToast = useCallback(
    (message: string) =>
      new Promise<void>((resolve) => {
        const token = ++tokenRef.current
        setToast({ id: token, message })
        window.setTimeout(() => {
          if (tokenRef.current === token) setToast(null)
          resolve()
        }, 4000)
      }),
    []
  )

  return [toast, showToast]
}
