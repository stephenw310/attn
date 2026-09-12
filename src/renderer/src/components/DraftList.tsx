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
      subject={(draft) => (draft.subject.trim() ? draft.subject : '(no subject)')}
      preview={(draft) => (
        <>
          <span className="flex-none text-accent">Draft</span>
          <span className="truncate">{draft.bodyText.replace(/\s+/g, ' ').trim() || 'No message yet'}</span>
        </>
      )}
      trailing={(draft) => (
        <time
          className="flex-none text-[10px] text-ink-dim"
          dateTime={new Date(draft.updatedAt).toISOString()}
          title={new Date(draft.updatedAt).toLocaleString()}
        >
          {new Date(draft.updatedAt).toLocaleDateString() === new Date().toLocaleDateString()
            ? new Date(draft.updatedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
            : new Date(draft.updatedAt).toLocaleDateString([], { month: 'short', day: 'numeric' })}
        </time>
      )}
      selectedIndex={selectedIndex}
      selectionVisible={selectionVisible}
      selectedRowRef={selectedRowRef}
      onOpen={onOpen}
    />
  )
}
