import { useLayoutEffect } from 'react'
import type { TriageAction } from '../../../shared/actions'
import type { DraftKind } from '../../../shared/drafts'
import { createCommand, registerCommands } from '../commands'
import type { MailView, NavigableMailView } from '../mailDisplay'

interface Options {
  selected: { id: string } | undefined
  selectedCount: number
  selectedIndex: number
  readerOpen: boolean
  view: MailView
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
  triage: (action: TriageAction) => void
  openSnooze: () => void
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
    triage,
    openSnooze,
    openLabel,
    openComposer,
    openReply,
    showToast,
    reopenUndoDraft
  } = options
  useLayoutEffect(
    () =>
      registerCommands([
        createCommand('navigate.next', navigateNext),
        createCommand('navigate.previous', navigatePrevious),
        ...(view !== 'drafts'
          ? [
              createCommand('selection.toggle', toggleSelection),
              createCommand('selection.extendNext', () => extendSelection(selectedIndex + 1)),
              createCommand('selection.extendPrevious', () => extendSelection(selectedIndex - 1)),
              ...(selectedCount > 0 ? [createCommand('selection.clear', clearSelection)] : [])
            ]
          : []),
        ...(view === 'outbox' ? [createCommand('outbox.close', closeOutbox)] : []),
        ...(readerOpen
          ? [createCommand('conversation.close', closeReader)]
          : view === 'outbox'
            ? [createCommand('outbox.open', openSelected)]
            : [createCommand('conversation.open', openSelected)]),
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
        ...(view !== 'drafts' && selected
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
        ...(view !== 'drafts' && selected
          ? [
              createCommand('triage.archive', () => triage({ kind: 'archive', threadIds: [selected.id] })),
              createCommand('triage.snooze', openSnooze, {
                title: view === 'snoozed' ? 'Change reminder / unsnooze' : 'Snooze / remind me later'
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
      closeReader,
      closeOutbox,
      extendSelection,
      markUnreadOn,
      navigateNext,
      navigatePrevious,
      openLabel,
      openComposer,
      openOutbox,
      openReply,
      openSelected,
      openSnooze,
      preserveSelectionOnRefreshRef,
      readerOpen,
      reopenUndoDraft,
      selected,
      selectedCount,
      selectedIndex,
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
