import { useLayoutEffect } from 'react'
import type { TriageAction } from '../../../shared/actions'
import { createCommand, registerCommands } from '../commands'

interface Options {
  threadCount: number
  selected: { id: string } | undefined
  selectedCount: number
  selectedIndex: number
  readerOpen: boolean
  view: 'inbox' | 'snoozed'
  starOn: boolean
  markUnreadOn: boolean
  preserveSelectionOnRefreshRef: React.RefObject<boolean>
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>
  clearSelection: () => void
  toggleSelection: () => void
  extendSelection: (index: number) => void
  openSelected: () => void
  closeReader: () => void
  switchView: (view: 'inbox' | 'snoozed') => void
  triage: (action: TriageAction) => void
  openSnooze: () => void
  openLabel: () => void
  showToast: (message: string) => void
}

export function useInboxCommands(options: Options): void {
  useLayoutEffect(
    () =>
      registerCommands([
        createCommand('navigate.next', () =>
          options.setSelectedIndex((index) => Math.min(index + 1, Math.max(options.threadCount - 1, 0)))
        ),
        createCommand('navigate.previous', () => options.setSelectedIndex((index) => Math.max(index - 1, 0))),
        createCommand('selection.toggle', options.toggleSelection),
        createCommand('selection.extendNext', () => options.extendSelection(options.selectedIndex + 1)),
        createCommand('selection.extendPrevious', () => options.extendSelection(options.selectedIndex - 1)),
        ...(options.selectedCount > 0 ? [createCommand('selection.clear', options.clearSelection)] : []),
        ...(options.readerOpen
          ? [createCommand('conversation.close', options.closeReader)]
          : [createCommand('conversation.open', options.openSelected)]),
        createCommand('view.inbox', () => options.switchView('inbox')),
        createCommand('view.snoozed', () => options.switchView('snoozed')),
        createCommand(
          'triage.archive',
          () => options.selected && options.triage({ kind: 'archive', threadIds: [options.selected.id] })
        ),
        createCommand('triage.snooze', options.openSnooze, {
          title: options.view === 'snoozed' ? 'Change reminder / unsnooze' : 'Snooze / remind me later'
        }),
        createCommand(
          'triage.trash',
          () => options.selected && options.triage({ kind: 'trash', threadIds: [options.selected.id] })
        ),
        createCommand(
          'triage.spam',
          () => options.selected && options.triage({ kind: 'spam', threadIds: [options.selected.id] })
        ),
        createCommand(
          'triage.star',
          () =>
            options.selected &&
            options.triage({ kind: 'star', threadIds: [options.selected.id], on: options.starOn }),
          { title: options.starOn ? 'Star' : 'Unstar' }
        ),
        createCommand(
          'triage.unread',
          () =>
            options.selected &&
            options.triage({
              kind: 'markUnread',
              threadIds: [options.selected.id],
              on: options.markUnreadOn
            }),
          { title: options.markUnreadOn ? 'Mark unread' : 'Mark read' }
        ),
        createCommand('triage.label', options.openLabel),
        createCommand('triage.undo', () => {
          if (!window.attn) return
          options.preserveSelectionOnRefreshRef.current = false
          void window.attn.mail
            .undo()
            .then((result) => {
              if (result) options.showToast(result.label)
              else options.preserveSelectionOnRefreshRef.current = true
            })
            .catch(() => {
              options.preserveSelectionOnRefreshRef.current = true
            })
        })
      ]),
    [options]
  )
}
