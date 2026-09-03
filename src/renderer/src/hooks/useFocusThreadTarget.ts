import { useEffect, useRef } from 'react'
import type { NavigableMailView } from '../mailDisplay'

interface Options {
  account: string | null
  /** Wait for split bootstrap: a targeted read before it would be declined. */
  splitsReady: boolean
  setActiveSplitId: (id: string) => void
  focusInboxThread: (
    threadId: string,
    splitId?: string | null,
    splitRevision?: number
  ) => Promise<number | null>
  switchView: (view: NavigableMailView, afterSwitch?: () => void) => void
  switchAccount: (accountId: string) => void
  clearSelection: () => void
  cancelPendingRestores: () => void
  setSelectedIndex: (index: number) => void
  setReaderOpen: (open: boolean) => void
  setDetachedDraftThread: (thread: null) => void
  selectedThreadIdRef: React.RefObject<string | null>
}

/**
 * A native notification click (F12/F18): main keeps the target pending until a
 * ready tree accepts and acknowledges it, so this subscription stays mounted
 * per account and never re-subscribes on a helper's identity change — every
 * handler is read from the render-time mirror when the target arrives.
 */
export function useFocusThreadTarget(options: Options): void {
  const latest = useRef(options)
  latest.current = options
  const { account, splitsReady } = options

  useEffect(() => {
    const bridge = window.attn
    if (!bridge || !account || !splitsReady) return
    return bridge.mail.onFocusThread((target) => {
      const handlers = latest.current
      // A notification for an inactive account switches there first (F12/F18).
      // The switch runs the guarded path — a live composer blocks it with the
      // usual toast — and the target stays pending in main, so the remounted
      // tree for the right account pulls it again and lands here as 'focus'.
      if (target.kind === 'switch') {
        handlers.switchAccount(target.accountId)
        return
      }
      if (target.accountId !== account) {
        // A stale tree can pull a target owned by another account while its
        // remount settles. Leave it un-acknowledged for the right tree and
        // nudge the guarded switch (a settling switch ignores the nudge).
        handlers.switchAccount(target.accountId)
        return
      }
      const threadId = target.threadId
      if (threadId === null) {
        // A summary names no single thread; it lands on this account's inbox.
        handlers.switchView('inbox', () => {
          latest.current.clearSelection()
          void bridge.mail.acknowledgeFocusThread(target.id).catch(() => {})
        })
        return
      }
      // Close the old reader before changing lists so auto-read cannot observe
      // an old cursor against Inbox and mutate the wrong thread.
      handlers.switchView('inbox', () => {
        latest.current.clearSelection()
        void (async () => {
          const openTarget = (nextIndex: number): void => {
            const current = latest.current
            // The notification target owns the selection: cancel any saved
            // record the switch queued so it cannot override this focus.
            current.cancelPendingRestores()
            current.selectedThreadIdRef.current = threadId
            current.setDetachedDraftThread(null)
            current.setSelectedIndex(nextIndex)
            current.setReaderOpen(true)
            // Clear the pending notification only after its target is applied.
            // If this tree is torn down or the targeted read loses a race, a
            // newly mounted tree can still pull and finish the request.
            void bridge.mail.acknowledgeFocusThread(target.id).catch(() => {})
          }
          // A rule edit can land between location lookup and page fetch. Retry
          // once with a fresh atomic split id + revision instead of dropping the
          // native notification click.
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const location = await bridge.splits.getThreadLocation(threadId)
            if (!location) {
              // The deterministic legacy test profile intentionally has no
              // split setup. Preserve its whole-Inbox notification path.
              const nextIndex = await latest.current.focusInboxThread(threadId, null).catch(() => null)
              if (nextIndex !== null) openTarget(nextIndex)
              return
            }
            latest.current.setActiveSplitId(location.splitId)
            const nextIndex = await latest.current
              .focusInboxThread(threadId, location.splitId, location.revision)
              .catch(() => null)
            if (nextIndex === null) continue
            openTarget(nextIndex)
            return
          }
        })().catch(() => {})
      })
    })
  }, [account, splitsReady])
}
