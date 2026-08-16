import type { ActionRevertNotice, RevertedAction } from '../shared/actionRevert'

export interface ActionRevertTransport {
  peek: (accountId: string) => Promise<ActionRevertNotice | null>
  acknowledge: (accountId: string, noticeId: number) => Promise<boolean>
  onAvailable: (callback: () => void) => () => void
}

/**
 * Delivers buffered notices at least once. A notice is acknowledged only after
 * the active subscriber receives it, so StrictMode cleanup and account changes
 * cannot consume a batch that no renderer displayed.
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
    if (draining || !active) return
    draining = true
    try {
      do {
        requested = false
        for (;;) {
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
  void drain()

  return () => {
    active = false
    offAvailable()
  }
}
