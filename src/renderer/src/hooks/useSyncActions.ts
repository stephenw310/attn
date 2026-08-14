import { useCallback, useLayoutEffect } from 'react'
import type { SyncState } from '../../../shared/mail'
import { createCommand, registerCommands } from '../commands'

interface SyncActions {
  retrySync: () => void
  copySyncError: (message: string) => void
}

export function useSyncActions(sync: SyncState, showToast: (message: string) => void): SyncActions {
  const retry = useCallback(() => {
    void window.attn?.sync.retry().catch(() => {})
  }, [])
  const copyError = useCallback(
    (message: string) => {
      if (!navigator.clipboard) {
        showToast('Could not copy error details')
        return
      }
      void navigator.clipboard
        .writeText(message)
        .then(() => showToast('Error details copied'))
        .catch(() => showToast('Could not copy error details'))
    },
    [showToast]
  )

  useLayoutEffect(() => {
    if (sync.phase !== 'error') return
    return registerCommands([
      createCommand('sync.retry', retry),
      createCommand('sync.error.copy', () => copyError(sync.message))
    ])
  }, [copyError, retry, sync])

  return { retrySync: retry, copySyncError: copyError }
}
