import { useLayoutEffect } from 'react'
import type { TriageAction } from '../../../shared/actions'
import type { DraftKind } from '../../../shared/drafts'
import { createCommand, registerCommands } from '../commands'

interface Options {
  threadCount: number
  selected: { id: string } | undefined
  selectedCount: number
  selectedIndex: number
  readerOpen: boolean
  view: 'inbox' | 'snoozed' | 'drafts' | 'outbox'
  starOn: boolean
  markUnreadOn: boolean
  preserveSelectionOnRefreshRef: React.RefObject<boolean>
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>
  clearSelection: () => void
  toggleSelection: () => void
  extendSelection: (index: number) => void
  openSelected: () => void
  closeReader: () => void
  switchView: (view: 'inbox' | 'snoozed' | 'drafts') => void
  openOutbox: () => void
  closeOutbox: () => void
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
    threadCount,
    selected,
    selectedCount,
    selectedIndex,
    readerOpen,
    view,
    starOn,
    markUnreadOn,
    preserveSelectionOnRefreshRef,
    setSelectedIndex,
    clearSelection,
    toggleSelection,
    extendSelection,
    openSelected,
    closeReader,
    switchView,
    openOutbox,
    closeOutbox,
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
        createCommand('navigate.next', () =>
          setSelectedIndex((index) => Math.min(index + 1, Math.max(threadCount - 1, 0)))
        ),
        createCommand('navigate.previous', () => {
          if (readerOpen && selectedIndex === 0) {
            closeReader()
            return
          }
          setSelectedIndex((index) => Math.max(index - 1, 0))
        }),
        createCommand('selection.toggle', toggleSelection),
        createCommand('selection.extendNext', () => extendSelection(selectedIndex + 1)),
        createCommand('selection.extendPrevious', () => extendSelection(selectedIndex - 1)),
        ...(selectedCount > 0 ? [createCommand('selection.clear', clearSelection)] : []),
        ...(view === 'outbox' ? [createCommand('outbox.close', closeOutbox)] : []),
        ...(readerOpen
          ? [createCommand('conversation.close', closeReader)]
          : view === 'outbox'
            ? [createCommand('outbox.open', openSelected)]
            : [createCommand('conversation.open', openSelected)]),
        createCommand('view.inbox', () => switchView('inbox')),
        createCommand('view.snoozed', () => switchView('snoozed')),
        createCommand('view.drafts', () => switchView('drafts')),
        createCommand('view.outbox', openOutbox),
        createCommand('composer.new', openComposer),
        ...(readerOpen
          ? [
              createCommand('composer.reply', () => openReply('reply')),
              createCommand('composer.replyAll', () => openReply('replyAll')),
              createCommand('composer.forward', () => openReply('forward'))
            ]
          : []),
        createCommand(
          'triage.archive',
          () => selected && triage({ kind: 'archive', threadIds: [selected.id] })
        ),
        createCommand('triage.snooze', openSnooze, {
          title: view === 'snoozed' ? 'Change reminder / unsnooze' : 'Snooze / remind me later'
        }),
        createCommand('triage.trash', () => selected && triage({ kind: 'trash', threadIds: [selected.id] })),
        createCommand('triage.spam', () => selected && triage({ kind: 'spam', threadIds: [selected.id] })),
        createCommand(
          'triage.star',
          () => selected && triage({ kind: 'star', threadIds: [selected.id], on: starOn }),
          { title: starOn ? 'Star' : 'Unstar' }
        ),
        createCommand(
          'triage.unread',
          () =>
            selected &&
            triage({
              kind: 'markUnread',
              threadIds: [selected.id],
              on: markUnreadOn
            }),
          { title: markUnreadOn ? 'Mark unread' : 'Mark read' }
        ),
        createCommand('triage.label', openLabel),
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
      setSelectedIndex,
      showToast,
      starOn,
      switchView,
      threadCount,
      toggleSelection,
      triage,
      view
    ]
  )
}
