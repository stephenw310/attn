import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  type AccountSyncStatus,
  type AuthSignInResult,
  type AuthStatus,
  isSignInCanceled
} from '../../../shared/auth'
import { clearAccountView } from '../accountViewMemory'
import { actionReconnectMessage } from '../actionReconnect'
import type { ShowToast } from './useToast'

interface Options {
  status: AuthStatus
  onStatus: (status: AuthStatus) => void
  /** Surfaced above the keyed remount: a failed removal outlives this tree. */
  onRemovalError: (message: string) => void
  showToast: ShowToast
  /** True while a composer is mounted — every account action refuses then. */
  composerOpen: React.RefObject<boolean>
  /** True while a composer's create round trip is still in flight. */
  composerOpening: React.RefObject<boolean>
  /** Persist this account's view memory before the tree remounts (F18). */
  saveAccountSnapshot: () => void
}

export interface AccountSession {
  /** Live per-account health, seeded once and then pushed by the utility. */
  accountStatuses: AccountSyncStatus[] | null
  /** A switch is settling: keyboard dispatch is blocked while it is true. */
  accountSwitchPending: boolean
  /** The same flag for async completions that outlive their closure. */
  accountSwitchPendingRef: React.RefObject<boolean>
  /** The confirmation is up: it owns Escape, so the shell's overlays stand down. */
  removeAccountOpen: boolean
  reconnectGoogle: () => Promise<AuthSignInResult | null>
  reconnectActions: () => void
  switchAccount: (accountId: string) => void
  addAccount: () => void
  requestRemoveAccount: () => void
  /** The sign-out confirmation, rendered by the shell when it is open (F18, D3). */
  removeAccountDialog: React.JSX.Element | null
  accountCommands: {
    accounts: readonly { id: string; email: string }[]
    activeAccountId: string | null
    switchTo: (accountId: string) => void
    add: () => void
    remove: () => void
  }
}

/**
 * The roster half of the mail shell (F18): reconnect, switch, add and remove,
 * plus the live health the header chip and the settings roster read. Switching
 * or adding remounts the whole mail surface, so every entry point refuses while
 * a composer is open and while another switch is still settling.
 */
export function useAccountSession(options: Options): AccountSession {
  const { status, onStatus, onRemovalError, showToast, saveAccountSnapshot } = options
  const composerOpenRef = options.composerOpen
  const composerOpeningRef = options.composerOpening
  const [accountStatuses, setAccountStatuses] = useState<AccountSyncStatus[] | null>(null)
  // A switch can wait on the utility (a retiring session holds it for up to
  // five seconds). Its settle remounts the tree, so while it is in flight
  // every composer open is inert — a composer that opened mid-wait would be
  // torn down with whatever was typed into it (F18). State blocks keyboard
  // dispatch; the ref answers async completions that outlive their closure.
  const [accountSwitchPending, setAccountSwitchPending] = useState(false)
  const accountSwitchPendingRef = useRef(false)
  const [removeAccountConfirm, setRemoveAccountConfirm] = useState(false)
  const removeAccountDeleteRef = useRef<HTMLButtonElement | null>(null)
  const activeAccount = status.activeAccountId ?? status.email ?? null

  // Live roster health: seeded once, then pushed by the utility whenever any
  // account's phase moves — the chip's attention mark and the menu status
  // lines follow without polling (F18). A push that lands while the seed read
  // is still in flight is the fresher answer, so the seed never overwrites it.
  useEffect(() => {
    const bridge = window.attn
    if (!bridge) return
    let pushed = false
    const unsubscribe = bridge.auth.onAccountStatuses((statuses) => {
      pushed = true
      setAccountStatuses(statuses)
    })
    bridge.auth
      .getAccountStatuses()
      .then((statuses) => {
        if (!pushed) setAccountStatuses(statuses)
      })
      .catch(() => {})
    return unsubscribe
  }, [])

  const reconnectGoogle = useCallback(async (): Promise<AuthSignInResult | null> => {
    if (!window.attn) return null
    try {
      const result = await window.attn.auth.signIn()
      onStatus(result.status)
      return result
    } catch (reason) {
      // A canceled or superseded sign-in is not a failure worth a toast.
      if (!isSignInCanceled(reason)) {
        void showToast(reason instanceof Error ? reason.message : 'Could not reconnect Google')
      }
      return null
    }
  }, [onStatus, showToast])

  const reconnectActions = useCallback(() => {
    void reconnectGoogle().then((result) => {
      if (result) void showToast(actionReconnectMessage(activeAccount ?? '', result))
    })
  }, [activeAccount, reconnectGoogle, showToast])

  const switchAccount = useCallback(
    (accountId: string) => {
      if (!window.attn || accountId === status.activeAccountId) return
      if (composerOpenRef.current || composerOpeningRef.current) {
        showToast('Save and close the draft before switching accounts')
        return
      }
      if (accountSwitchPendingRef.current) return
      // Capture this account's view, selection, and scroll before the tree
      // remounts, so returning here restores them (F18).
      saveAccountSnapshot()
      accountSwitchPendingRef.current = true
      setAccountSwitchPending(true)
      void window.attn.auth
        .setActiveAccount(accountId)
        .then(onStatus)
        .catch(() => void showToast('Could not switch accounts'))
        .finally(() => {
          accountSwitchPendingRef.current = false
          setAccountSwitchPending(false)
        })
    },
    [composerOpenRef, composerOpeningRef, onStatus, saveAccountSnapshot, showToast, status.activeAccountId]
  )

  // Adding an account is the same OAuth flow as reconnecting: an existing
  // address refreshes its tokens, a new one joins the roster (F18). Sign-in
  // no longer activates the addition — the browser flow can complete minutes
  // later, when a composer may be open — so activation goes through the
  // guarded switch here, and a blocked switch leaves the account added but
  // not active rather than dropping unsaved keystrokes.
  const addAccount = useCallback(() => {
    if (composerOpenRef.current || composerOpeningRef.current) {
      showToast('Save and close the draft before adding an account')
      return
    }
    void reconnectGoogle().then((result) => {
      if (!result?.accountId || result.accountId === result.status.activeAccountId) return
      if (composerOpenRef.current || composerOpeningRef.current) {
        void showToast(`Added ${result.accountId} — save the draft, then switch from the account menu`)
        return
      }
      switchAccount(result.accountId)
    })
  }, [composerOpenRef, composerOpeningRef, reconnectGoogle, showToast, switchAccount])

  // Removing an account is destructive enough for a confirmation that also
  // decides the local data's fate (F18, D3): Delete purges every local trace,
  // Keep leaves the rows dormant for a future re-add to resume from cursors.
  const requestRemoveAccount = useCallback(() => {
    if (composerOpenRef.current || composerOpeningRef.current) {
      showToast('Save and close the draft before removing an account')
      return
    }
    if (accountSwitchPendingRef.current) return
    setRemoveAccountConfirm(true)
  }, [composerOpenRef, composerOpeningRef, showToast])

  const removeActiveAccount = useCallback(
    (deleteData: boolean) => {
      const target = status.activeAccountId
      if (
        !window.attn ||
        !target ||
        composerOpenRef.current ||
        composerOpeningRef.current ||
        accountSwitchPendingRef.current
      )
        return
      accountSwitchPendingRef.current = true
      setAccountSwitchPending(true)
      setRemoveAccountConfirm(false)
      void window.attn.auth
        .removeAccount(target, deleteData)
        .then((next) => {
          clearAccountView(target)
          onStatus(next)
        })
        .catch(() => {
          onRemovalError(
            deleteData
              ? `Could not delete all local data for ${target}. Re-add the account if needed, then sign out and delete local data again.`
              : `Could not remove the account ${target}. Check the account menu and try again if it is still listed.`
          )
          // The removal can fail after main already dropped the tokens and
          // activated the next account; re-pull the status so this tree never
          // keeps rendering a removed account over another account's reads.
          return window.attn?.auth
            .getStatus()
            .then(onStatus)
            .catch(() => {})
        })
        .finally(() => {
          accountSwitchPendingRef.current = false
          setAccountSwitchPending(false)
        })
    },
    [composerOpenRef, composerOpeningRef, onRemovalError, onStatus, status.activeAccountId]
  )

  useEffect(() => {
    if (!removeAccountConfirm) return
    // Focus the first choice once, on open — an inline ref callback would
    // re-run on every re-render and yank focus back onto the destructive
    // button after the user tabbed to Keep or Cancel.
    removeAccountDeleteRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation()
        setRemoveAccountConfirm(false)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [removeAccountConfirm])

  const accountCommands = useMemo(
    () => ({
      accounts: status.accounts,
      activeAccountId: status.activeAccountId,
      switchTo: switchAccount,
      add: addAccount,
      remove: requestRemoveAccount
    }),
    [addAccount, requestRemoveAccount, status.accounts, status.activeAccountId, switchAccount]
  )

  const removeAccountDialog =
    removeAccountConfirm && activeAccount ? (
      // biome-ignore lint/a11y/useKeyWithClickEvents: Escape is handled by the dialog's key capture
      // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click is the pointer dismissal path
      <div
        data-testid="remove-account-dialog"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
        onClick={() => setRemoveAccountConfirm(false)}
      >
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the handler only stops backdrop dismissal */}
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`Sign out of ${activeAccount}?`}
          className="w-[460px] rounded-lg border border-edge bg-raised p-5 shadow-menu"
          onClick={(event) => event.stopPropagation()}
        >
          <h2 className="text-sm font-semibold text-ink">Sign out of {activeAccount}?</h2>
          <p className="mt-2 text-[13px] leading-relaxed text-ink-dim">
            This signs the account out and stops its sync. Choose what happens to its mail cached on this
            device: deleting removes every local trace; keeping leaves it dormant so adding the account again
            picks up where it left off.
          </p>
          <div className="mt-4 flex flex-col gap-1.5">
            <button
              type="button"
              data-testid="remove-account-delete"
              ref={removeAccountDeleteRef}
              onClick={() => removeActiveAccount(true)}
              className="w-full cursor-pointer rounded-md border border-accent/40 bg-accent/10 px-3 py-1.5 text-[13px] font-medium text-accent hover:bg-accent/20"
            >
              Sign out and delete local data
            </button>
            <button
              type="button"
              data-testid="remove-account-keep"
              onClick={() => removeActiveAccount(false)}
              className="w-full cursor-pointer rounded-md border border-edge px-3 py-1.5 text-[13px] text-ink-dim hover:bg-active hover:text-ink"
            >
              Sign out and keep local data
            </button>
            <button
              type="button"
              data-testid="remove-account-cancel"
              onClick={() => setRemoveAccountConfirm(false)}
              className="w-full cursor-pointer rounded-md px-3 py-1.5 text-[13px] text-ink-faint hover:bg-active hover:text-ink"
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    ) : null

  return {
    accountStatuses,
    accountSwitchPending,
    accountSwitchPendingRef,
    removeAccountOpen: removeAccountConfirm,
    reconnectGoogle,
    reconnectActions,
    switchAccount,
    addAccount,
    requestRemoveAccount,
    removeAccountDialog,
    accountCommands
  }
}
