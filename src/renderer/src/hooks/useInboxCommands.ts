import { useLayoutEffect } from 'react'
import type { TriageAction } from '../../../shared/actions'
import type { DraftKind } from '../../../shared/drafts'
import { formatSnoozeDate, parseSnoozeText } from '../../../shared/snooze'
import { createCommand, registerCommands } from '../commands'
import type { MailView, NavigableMailView } from '../mailDisplay'

interface Options {
  selected: { id: string } | undefined
  selectedCount: number
  selectedIndex: number
  readerOpen: boolean
  view: MailView
  searchOpen: boolean
  searchBrowsing: boolean
  sidebarCollapsed: boolean
  starOn: boolean
  markUnreadOn: boolean
  preserveSelectionOnRefreshRef: React.RefObject<boolean>
  navigateNext: () => void
  navigatePrevious: () => void
  clearSelection: () => void
  toggleSelection: () => void
  extendSelection: (index: number) => void
  openSelected: () => void
  closeReader: () => void
  switchView: (view: NavigableMailView) => void
  openOutbox: () => void
  closeOutbox: () => void
  toggleSidebar: () => void
  openSearch: () => void
  focusSearchQuery: () => void
  clearSearch: () => void
  triage: (action: TriageAction) => void
  openSnooze: () => void
  snoozeAt: (dueAt: number) => void
  openLabel: () => void
  openComposer: () => void
  openReply: (kind: Exclude<DraftKind, 'new'>) => void
  showToast: (message: string) => void
  reopenUndoDraft: (id: string) => void
}

export function useInboxCommands(options: Options): void {
  const {
    selected,
    selectedCount,
    selectedIndex,
    readerOpen,
    view,
    searchOpen,
    searchBrowsing,
    sidebarCollapsed,
    starOn,
    markUnreadOn,
    preserveSelectionOnRefreshRef,
    navigateNext,
    navigatePrevious,
    clearSelection,
    toggleSelection,
    extendSelection,
    openSelected,
    closeReader,
    switchView,
    openOutbox,
    closeOutbox,
    toggleSidebar,
    openSearch,
    focusSearchQuery,
    clearSearch,
    triage,
    openSnooze,
    snoozeAt,
    openLabel,
    openComposer,
    openReply,
    showToast,
    reopenUndoDraft
  } = options
  const mailCommandsEnabled = !searchOpen || searchBrowsing || readerOpen
  useLayoutEffect(
    () =>
      registerCommands([
        createCommand('search.open', openSearch),
        ...(searchBrowsing ? [createCommand('search.focusQuery', focusSearchQuery)] : []),
        ...(searchOpen && !readerOpen ? [createCommand('search.clear', clearSearch)] : []),
        ...(mailCommandsEnabled
          ? [
              createCommand('navigate.next', navigateNext),
              createCommand('navigate.previous', navigatePrevious)
            ]
          : []),
        ...(mailCommandsEnabled && (searchOpen || view !== 'drafts')
          ? [
              createCommand('selection.toggle', toggleSelection),
              createCommand('selection.extendNext', () => extendSelection(selectedIndex + 1)),
              createCommand('selection.extendPrevious', () => extendSelection(selectedIndex - 1)),
              ...(searchBrowsing
                ? [createCommand('selection.clear', focusSearchQuery, { title: 'Edit search query' })]
                : selectedCount > 0
                  ? [createCommand('selection.clear', clearSelection)]
                  : [])
            ]
          : []),
        ...(!searchOpen && view === 'outbox' ? [createCommand('outbox.close', closeOutbox)] : []),
        ...(mailCommandsEnabled
          ? readerOpen
            ? [createCommand('conversation.close', closeReader)]
            : !searchOpen && view === 'outbox'
              ? [createCommand('outbox.open', openSelected)]
              : [createCommand('conversation.open', openSelected)]
          : []),
        ...(searchOpen && readerOpen ? [createCommand('search.clear', clearSearch)] : []),
        createCommand('view.inbox', () => switchView('inbox')),
        createCommand('view.allMail', () => switchView('allMail')),
        createCommand('view.sent', () => switchView('sent')),
        createCommand('view.starred', () => switchView('starred')),
        createCommand('view.snoozed', () => switchView('snoozed')),
        createCommand('view.drafts', () => switchView('drafts')),
        createCommand('view.spam', () => switchView('spam')),
        createCommand('view.trash', () => switchView('trash')),
        createCommand('view.outbox', openOutbox),
        createCommand('layout.sidebar.toggle', toggleSidebar, {
          title: sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'
        }),
        createCommand('composer.new', openComposer),
        ...(mailCommandsEnabled && (searchOpen || view !== 'drafts') && selected
          ? [
              createCommand('composer.reply', () => openReply('reply'), {
                context: readerOpen ? 'reader' : 'list'
              }),
              ...(readerOpen ? [createCommand('composer.replyAll', () => openReply('replyAll'))] : []),
              createCommand('composer.forward', () => openReply('forward'), {
                context: readerOpen ? 'reader' : 'list'
              })
            ]
          : []),
        ...(mailCommandsEnabled && (searchOpen || view !== 'drafts') && selected
          ? [
              createCommand('triage.archive', () => triage({ kind: 'archive', threadIds: [selected.id] })),
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
              createCommand('triage.trash', () => triage({ kind: 'trash', threadIds: [selected.id] })),
              createCommand('triage.spam', () => triage({ kind: 'spam', threadIds: [selected.id] })),
              createCommand(
                'triage.star',
                () => triage({ kind: 'star', threadIds: [selected.id], on: starOn }),
                { title: starOn ? 'Star' : 'Unstar' }
              ),
              createCommand(
                'triage.unread',
                () =>
                  triage({
                    kind: 'markUnread',
                    threadIds: [selected.id],
                    on: markUnreadOn
                  }),
                { title: markUnreadOn ? 'Mark unread' : 'Mark read' }
              ),
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
      clearSelection,
      clearSearch,
      closeReader,
      closeOutbox,
      extendSelection,
      focusSearchQuery,
      markUnreadOn,
      mailCommandsEnabled,
      navigateNext,
      navigatePrevious,
      openLabel,
      openComposer,
      openOutbox,
      openReply,
      openSearch,
      openSelected,
      openSnooze,
      preserveSelectionOnRefreshRef,
      readerOpen,
      reopenUndoDraft,
      selected,
      selectedCount,
      selectedIndex,
      snoozeAt,
      searchOpen,
      searchBrowsing,
      showToast,
      sidebarCollapsed,
      starOn,
      switchView,
      toggleSidebar,
      toggleSelection,
      triage,
      view
    ]
  )
}
