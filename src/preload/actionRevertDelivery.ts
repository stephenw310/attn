import type { ActionRevertNotice, RevertedAction } from '../shared/actionRevert'

export interface ActionRevertTransport {
  peek: (accountId: string) => Promise<ActionRevertNotice | null>
  acknowledge: (accountId: string, noticeId: number) => Promise<boolean>
  onAvailable: (callback: () => void) => () => void
  /** Whether this window is on screen — a hidden window displays nothing. */
  isVisible: () => boolean
  onVisibilityChange: (callback: () => void) => () => void
}

/**
 * Delivers buffered notices at least once. A notice is acknowledged only after
 * the active subscriber has *displayed* it, so StrictMode cleanup, account
 * changes, and a hidden window (background launch, or close-to-tray) cannot
 * consume a batch the user never saw.
 */
export function subscribeToActionReverts(
  accountId: string,
  transport: ActionRevertTransport,
  callback: (actions: RevertedAction[]) => void | Promise<void>
): () => void {
  let active = true
  let draining = false
  let requested = true

  const drain = async (): Promise<void> => {
    // A background window still mounts a renderer and would otherwise run the
    // toast out inside an invisible window, acknowledging it unseen.
    if (draining || !active || !transport.isVisible()) return
    draining = true
    try {
      do {
        requested = false
        for (;;) {
          if (!transport.isVisible()) break
          const notice = await transport.peek(accountId)
          if (!active || !notice) break
          await callback(notice.actions)
          if (!active) break
          if (!(await transport.acknowledge(accountId, notice.id))) break
        }
      } while (active && requested)
    } catch {
      // Main may be tearing down or switching accounts. Without an ack, the
      // notice remains buffered for the next active subscription.
    } finally {
      draining = false
      if (active && requested) void drain()
    }
  }

  const offAvailable = transport.onAvailable(() => {
    requested = true
    void drain()
  })
  // Anything buffered while the window was hidden is delivered when it appears.
  const offVisibility = transport.onVisibilityChange(() => {
    requested = true
    void drain()
  })
  void drain()

  return () => {
    active = false
    offAvailable()
    offVisibility()
  }
}
