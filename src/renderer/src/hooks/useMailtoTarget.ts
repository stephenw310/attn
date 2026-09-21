import { useEffect, useRef } from 'react'
import type { MailtoPrefill } from '../../../shared/mailto'
import type { ShowToast } from './useToast'

interface Options {
  account: string | null
  /** A composer already on screen owns the window; a link must not replace it. */
  composerOpen: boolean
  openComposer: (prefill?: MailtoPrefill) => Promise<boolean>
  /** Settings and the split manager hide the mail pane a composer mounts in. */
  closePreferences: () => void
  showToast: ShowToast
}

/**
 * A `mailto:` link the OS handed Attn (F16). Main keeps the request pending
 * until a ready tree opens the composer and acknowledges it, so this
 * subscription stays mounted per account and reads its handlers from the
 * render-time mirror when a link arrives — the same shape as
 * `useFocusThreadTarget`, minus the account: a link says who to write to,
 * never which mailbox writes.
 */
export function useMailtoTarget(options: Options): void {
  const latest = useRef(options)
  latest.current = options
  const { account } = options

  useEffect(() => {
    const bridge = window.attn
    if (!bridge || !account) return
    // The bridge subscription already drops a pull that lands after
    // unsubscribing, so this effect needs no staleness flag of its own.
    const unsubscribe = bridge.mail.onComposeRequest((target) => {
      const handlers = latest.current
      const acknowledge = (): void => {
        void bridge.mail.acknowledgeComposeRequest(target.id).catch(() => {})
      }
      // `composer.new` is unavailable while a composer is mounted, and a link
      // gets no more reach than the command: the open draft keeps the window.
      // The request is acknowledged all the same, so closing that draft minutes
      // later cannot surprise the user with a composer they no longer expect.
      if (handlers.composerOpen) {
        const first = target.prefill.to[0]?.email
        void handlers.showToast(
          first ? `Close the open draft to write to ${first}` : 'Close the open draft to write a new message'
        )
        acknowledge()
        return
      }
      // A composer must never mount under Settings, where it is hidden and
      // still receives composer keys. The link is a user action, so it closes
      // the preferences pages the same way Escape does.
      handlers.closePreferences()
      void handlers
        .openComposer(target.prefill)
        .then((opened) => {
          // Acknowledge on the draft, not on this tree: once the row exists a
          // later pull would create a second one. A refused open (a settling
          // account switch, an open already in flight) leaves the request
          // pending for the tree that remounts after the switch.
          if (opened) acknowledge()
        })
        .catch(() => {})
    })
    return unsubscribe
  }, [account])
}
