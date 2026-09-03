import { createContext, useContext } from 'react'
import type { ShowToast } from './hooks/useToast'

/**
 * The one toast surface the mail shell renders. Everything below Inbox reaches
 * it through this context instead of a prop threaded down every level: the
 * settings sections, the snippet manager and the conversation's message cards
 * all raise toasts, and none of them cares where the toast is shown.
 *
 * The default is a no-op so a component rendered outside the shell (a test
 * harness, a future standalone window) still runs.
 */
export const ToastContext = createContext<ShowToast>(async () => {})

export function useShowToast(): ShowToast {
  return useContext(ToastContext)
}
