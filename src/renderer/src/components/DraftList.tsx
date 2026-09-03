import type { Draft } from '../../../shared/drafts'
import { recipientLabel, SimpleRowList } from './SimpleRowList'

interface DraftListProps {
  drafts: readonly Draft[]
  readerOpen: boolean
  selectedIndex: number
  selectionVisible?: boolean
  selectedRowRef: React.RefObject<HTMLDivElement | null>
  listRef: React.RefObject<HTMLElement | null>
  onOpen: (index: number) => void
}

export function DraftList({
  drafts,
  readerOpen,
  selectedIndex,
  selectionVisible = true,
  selectedRowRef,
  listRef,
  onOpen
}: DraftListProps): React.JSX.Element {
  return (
    <SimpleRowList
      testId="draft-list"
      ariaLabel="Drafts"
      listRef={listRef}
      containerClassName={`min-h-0 flex-1 overflow-y-auto py-2 outline-none ${readerOpen ? 'hidden' : ''}`}
      focusable
      emptyLabel="No drafts"
      rows={drafts}
      rowKey={(draft) => draft.id}
      rowTestId="draft-row"
      rowData={(draft) => ({ 'data-draft-id': draft.id })}
      recipients={(draft) =>
        recipientLabel(
          [draft.to, draft.cc, draft.bcc],
          draft.kind === 'forward' ? 'Forward' : 'No recipients'
        )
      }
      subject={(draft) => draft.subject || '(no subject)'}
      trailing={(draft) => (
        <span className="text-xs capitalize text-ink-faint">
          {draft.kind === 'replyAll' ? 'reply all' : draft.kind}
        </span>
      )}
      selectedIndex={selectedIndex}
      selectionVisible={selectionVisible}
      selectedRowRef={selectedRowRef}
      onOpen={onOpen}
    />
  )
}
