import { useCallback, useLayoutEffect } from 'react'
import type { TriageAction } from '../../../shared/actions'
import type { DraftKind } from '../../../shared/drafts'
import { formatSnoozeDate, parseSnoozeText } from '../../../shared/snooze'
import {
  createAccountSwitchCommand,
  createCommand,
  createDynamicSplitCommand,
  registerCommands
} from '../commands'
import type { MailView, NavigableMailView } from '../list/mailDisplay'

/** The triage verbs that act on the focused row alone. */
type SelectedTriage = { kind: 'archive' | 'trash' | 'spam' } | { kind: 'star' | 'markUnread'; on: boolean }

interface Options {
  /** Whether a row is focused at all — the commands' registration condition. */
  hasSelection: boolean
  /** Which row, read when a command runs: it moves on every J/K (P1). */
  selectedRef: React.RefObject<{ id: string } | undefined>
  selectedCount: number
  readerOpen: boolean
  view: MailView
  searchOpen: boolean
  searchBrowsing: boolean
  footerCollapsed: boolean
  sidebarCollapsed: boolean
  /** Star/unread titles and payloads are read lazily for the same reason. */
  starOnRef: React.RefObject<boolean>
  markUnreadOnRef: React.RefObject<boolean>
  moveAllowed: boolean
  preserveSelectionOnRefreshRef: React.RefObject<boolean>
  navigateNext: () => void
  navigatePrevious: () => void
  clearSelection: () => void
  toggleSelection: () => void
  /** Shift+J/K: the focused index comes from the selection hook's own ref (P1). */
  extendSelectionBy: (delta: number) => void
  openSelected: () => void
  closeReader: () => void
  switchView: (view: NavigableMailView) => void
  openOutbox: () => void
  closeOutbox: () => void
  discardSelectedDraft: (() => void) | null
  toggleFooter: () => void
  toggleSidebar: () => void
  openSearch: () => void
  focusSearchQuery: () => void
  searchAllEnabled: boolean
  submitSearch: () => void
  clearSearch: () => void
  triage: (action: TriageAction) => void
  openSnooze: () => void
  snoozeAt: (dueAt: number) => void
  openLabel: () => void
  openMove: () => void
  markNotDone: () => void
  openComposer: () => void
  openReply: (kind: Exclude<DraftKind, 'new'>) => void
  openMessageOrReplyAll: () => void
  showToast: (message: string) => void
  reopenUndoDraft: (id: string) => void
  splitCommands: {
    previous: () => void
    next: () => void
    manage: () => void
    goTo: readonly { id: string; name: string; run: () => void }[]
  } | null
  accountCommands: {
    /** Switcher order (F18); `Mod+1..9` covers the first nine. */
    accounts: readonly { id: string; email: string }[]
    activeAccountId: string | null
    switchTo: (accountId: string) => void
    add: () => void
    /** Opens the Remove-account confirmation for the active account (F18, D3). */
    remove: () => void
  }
}

export function useInboxCommands(options: Options): void {
  const {
    hasSelection,
    selectedRef,
    selectedCount,
    readerOpen,
    view,
    searchOpen,
    searchBrowsing,
    footerCollapsed,
    sidebarCollapsed,
    starOnRef,
    markUnreadOnRef,
    moveAllowed,
    preserveSelectionOnRefreshRef,
    navigateNext,
    navigatePrevious,
    clearSelection,
    toggleSelection,
    extendSelectionBy,
    openSelected,
    closeReader,
    switchView,
    openOutbox,
    closeOutbox,
    discardSelectedDraft,
    toggleFooter,
    toggleSidebar,
    openSearch,
    focusSearchQuery,
    searchAllEnabled,
    submitSearch,
    clearSearch,
    triage,
    openSnooze,
    snoozeAt,
    openLabel,
    openMove,
    markNotDone,
    openComposer,
    openReply,
    openMessageOrReplyAll,
    showToast,
    reopenUndoDraft,
    splitCommands,
    accountCommands
  } = options
  const mailCommandsEnabled = !searchOpen || searchBrowsing || readerOpen
  // The focused row is read at invocation, never captured at registration.
  const triageSelected = useCallback(
    (action: SelectedTriage): void => {
      const id = selectedRef.current?.id
      if (id) triage({ ...action, threadIds: [id] })
    },
    [selectedRef, triage]
  )
  useLayoutEffect(
    () =>
      registerCommands([
        createCommand('search.open', openSearch),
        ...(searchOpen && !readerOpen && !searchBrowsing
          ? [createCommand('search.submit', submitSearch)]
          : []),
        ...(searchBrowsing ? [createCommand('search.focusQuery', focusSearchQuery)] : []),
        ...(searchOpen && !readerOpen && searchAllEnabled
          ? [createCommand('search.allGmail', submitSearch)]
          : []),
        ...(searchOpen && !readerOpen ? [createCommand('search.clear', clearSearch)] : []),
        ...(splitCommands
          ? [
              createCommand('split.manage', splitCommands.manage),
              ...(!readerOpen && !searchOpen && view === 'inbox' && splitCommands.goTo.length > 1
                ? [
                    createCommand('split.previous', splitCommands.previous),
                    createCommand('split.next', splitCommands.next)
                  ]
                : []),
              ...splitCommands.goTo.map((split) =>
                createDynamicSplitCommand(split.id, `Go to: ${split.name}`, split.run)
              )
            ]
          : []),
        createCommand('account.add', accountCommands.add),
        createCommand('account.remove', accountCommands.remove),
        // With one account there is nothing to switch to; the commands appear
        // as soon as a second account exists.
        ...(accountCommands.accounts.length > 1
          ? accountCommands.accounts.map((account, index) =>
              createAccountSwitchCommand(
                account.id,
                account.id === accountCommands.activeAccountId
                  ? `Switch to: ${account.email} (current)`
                  : `Switch to: ${account.email}`,
                () => accountCommands.switchTo(account.id),
                index < 9 ? `Mod+${index + 1}` : undefined
              )
            )
          : []),
        ...(mailCommandsEnabled
          ? [
              createCommand('navigate.next', navigateNext),
              createCommand('navigate.previous', navigatePrevious)
            ]
          : []),
        ...(mailCommandsEnabled && (searchOpen || view !== 'drafts')
          ? [
              createCommand('selection.toggle', toggleSelection),
              createCommand('selection.extendNext', () => extendSelectionBy(1)),
              createCommand('selection.extendPrevious', () => extendSelectionBy(-1)),
              ...(searchBrowsing
                ? [createCommand('selection.clear', focusSearchQuery, { title: 'Edit search query' })]
                : selectedCount > 0
                  ? [createCommand('selection.clear', clearSelection)]
                  : [])
            ]
          : []),
        ...(!searchOpen && view === 'outbox' ? [createCommand('outbox.close', closeOutbox)] : []),
        ...(discardSelectedDraft ? [createCommand('draft.discard', discardSelectedDraft)] : []),
        ...(mailCommandsEnabled
          ? readerOpen
            ? [createCommand('conversation.close', closeReader)]
            : !searchOpen && view === 'outbox'
              ? [createCommand('outbox.open', openSelected)]
              : [createCommand('conversation.open', openSelected)]
          : []),
        ...(searchOpen && readerOpen ? [createCommand('search.clear', clearSearch)] : []),
        createCommand('view.inbox', () => switchView('inbox'), {
          ...(!readerOpen && !searchOpen && view !== 'inbox' ? { shortcutAliases: ['Tab'] } : {})
        }),
        createCommand('view.allMail', () => switchView('allMail')),
        createCommand('view.sent', () => switchView('sent')),
        createCommand('view.starred', () => switchView('starred')),
        createCommand('view.snoozed', () => switchView('snoozed')),
        createCommand('view.drafts', () => switchView('drafts')),
        createCommand('view.spam', () => switchView('spam')),
        createCommand('view.trash', () => switchView('trash')),
        createCommand('view.outbox', openOutbox),
        createCommand('layout.footer.toggle', toggleFooter, {
          title: footerCollapsed ? 'Show keyboard hints' : 'Hide keyboard hints'
        }),
        createCommand('layout.sidebar.toggle', toggleSidebar, {
          title: sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'
        }),
        createCommand('composer.new', openComposer),
        ...(mailCommandsEnabled && (readerOpen || searchOpen || view !== 'drafts') && hasSelection
          ? [
              createCommand('composer.reply', () => openReply('reply'), {
                context: readerOpen ? 'reader' : 'list'
              }),
              ...(readerOpen
                ? [
                    createCommand('composer.replyAll', () => openReply('replyAll')),
                    createCommand('message.openOrReplyAll', openMessageOrReplyAll)
                  ]
                : []),
              createCommand('composer.forward', () => openReply('forward'), {
                context: readerOpen ? 'reader' : 'list'
              })
            ]
          : []),
        ...(mailCommandsEnabled && (searchOpen || view !== 'drafts') && hasSelection
          ? [
              createCommand('triage.archive', () => triageSelected({ kind: 'archive' })),
              createCommand('triage.notDone', markNotDone),
              createCommand('triage.snooze', openSnooze, {
                title: view === 'snoozed' ? 'Change reminder / unsnooze' : 'Snooze / remind me later',
                argument: {
                  prefixes: ['remind me', 'snooze'],
                  parse: (input) => {
                    const dueAt = parseSnoozeText(input)
                    return dueAt !== null && dueAt > Date.now()
                      ? { label: `Snooze until ${formatSnoozeDate(dueAt)}`, value: dueAt }
                      : null
                  },
                  run: (value) => {
                    if (typeof value === 'number') snoozeAt(value)
                  }
                }
              }),
              createCommand('triage.trash', () => triageSelected({ kind: 'trash' })),
              createCommand('triage.spam', () => triageSelected({ kind: 'spam' })),
              createCommand('triage.star', () => triageSelected({ kind: 'star', on: starOnRef.current }), {
                titleOf: () => (starOnRef.current ? 'Star' : 'Unstar')
              }),
              createCommand(
                'triage.unread',
                () => triageSelected({ kind: 'markUnread', on: markUnreadOnRef.current }),
                { titleOf: () => (markUnreadOnRef.current ? 'Mark unread' : 'Mark read') }
              ),
              ...(moveAllowed ? [createCommand('triage.move', openMove)] : []),
              createCommand('triage.label', openLabel)
            ]
          : []),
        createCommand('triage.undo', () => {
          if (!window.attn) return
          preserveSelectionOnRefreshRef.current = false
          void window.attn.mail
            .undo()
            .then((result) => {
              if (result) {
                showToast(result.label)
                if (result.reopenDraftId) reopenUndoDraft(result.reopenDraftId)
              } else preserveSelectionOnRefreshRef.current = true
            })
            .catch(() => {
              preserveSelectionOnRefreshRef.current = true
            })
        })
      ]),
    [
      accountCommands,
      clearSelection,
      clearSearch,
      closeReader,
      closeOutbox,
      discardSelectedDraft,
      extendSelectionBy,
      focusSearchQuery,
      hasSelection,
      markNotDone,
      markUnreadOnRef,
      moveAllowed,
      mailCommandsEnabled,
      navigateNext,
      navigatePrevious,
      openLabel,
      openMove,
      openComposer,
      openOutbox,
      openReply,
      openMessageOrReplyAll,
      openSearch,
      openSelected,
      openSnooze,
      preserveSelectionOnRefreshRef,
      readerOpen,
      reopenUndoDraft,
      selectedCount,
      snoozeAt,
      searchOpen,
      submitSearch,
      searchAllEnabled,
      searchBrowsing,
      showToast,
      footerCollapsed,
      sidebarCollapsed,
      splitCommands,
      starOnRef,
      switchView,
      toggleFooter,
      toggleSidebar,
      toggleSelection,
      triageSelected,
      view
    ]
  )
}
