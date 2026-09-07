import type { ThreadListView } from '../../../shared/mail'
import type { InboxController } from '../hooks/useInboxController'
import { type MailView, userLabelId } from '../list/mailDisplay'
import { ConversationView } from './ConversationView'
import { DraftList } from './DraftList'
import { PaperSheet } from './Hand'
import { InboxOverlays } from './InboxOverlays'
import { InboxZero } from './InboxZero'
import { MailFooter } from './MailFooter'
import { MailHeader } from './MailHeader'
import { MailSidebar, SIDEBAR_WIDTH } from './MailSidebar'
import { OutboxList } from './OutboxList'
import { SearchHeader, searchCoverageText } from './SearchHeader'
import { ServerSearchRow } from './ServerSearchRow'
import { SettingsView } from './SettingsView'
import { SplitStrip } from './SplitStrip'
import { ThreadList } from './ThreadList'
import { ViewTitle } from './ViewTitle'

function threadListKind(view: MailView): ThreadListView | 'label' {
  if (userLabelId(view)) return 'label'
  if (view !== 'drafts' && view !== 'outbox') return view as ThreadListView
  return 'inbox'
}

export function InboxLayout({ controller: c }: { controller: InboxController }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col">
      <PaperSheet bandWidth={c.sidebarCollapsed || c.fullWindowComposerDraft ? 0 : SIDEBAR_WIDTH} />
      <MailHeader
        pendingActionCount={c.pendingActionCount}
        pausedActionCount={c.pausedActionCount}
        outboxCount={c.realOutbox.length}
        selectionCount={selectedForCount(c)}
        composerOpen={c.fullWindowComposerDraft !== null}
        sidebarCollapsed={c.sidebarCollapsed}
        status={c.status}
        accountStatuses={c.accounts.accountStatuses}
        onReconnectActions={c.accounts.reconnectActions}
        onOpenOutbox={c.openOutbox}
        onToggleSidebar={c.toggleSidebar}
        onSwitchAccount={c.accounts.switchAccount}
        onAddAccount={c.accounts.addAccount}
        onRemoveAccount={c.accounts.requestRemoveAccount}
        onOpenSettings={() => c.openSettings(null)}
        onOpenCheatSheet={c.openCheatSheet}
        accountActionsBlocked={c.accountActionsBlocked}
      />

      {c.accounts.removeAccountDialog}

      <div
        className={`min-h-0 flex-1 ${c.fullWindowComposerDraft ? 'hidden' : 'flex'}`}
        aria-hidden={!!c.fullWindowComposerDraft}
      >
        {/* A full-window composer hides this column. Unmount the sidebar with
            it so the account line it carries is not left in the page twice. */}
        {!c.sidebarCollapsed && !c.fullWindowComposerDraft && (
          <MailSidebar
            view={c.view}
            labels={c.labels}
            mailboxCounts={c.realMailboxCounts}
            draftCount={c.realDrafts.length}
            outboxCount={c.realOutbox.length}
            onSwitchView={c.switchView}
            onOpenOutbox={c.openOutbox}
          />
        )}
        {/* The footer belongs to this column, not to the window: the sidebar
            runs the full height of the page beside it, as the sheet does. */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1">
            {c.settingsOpen && c.activeAccount && (
              <SettingsView
                status={c.status}
                accountStatuses={c.accounts.accountStatuses}
                settings={c.appSettings}
                accountSettings={c.accountSettings}
                onUpdateSetting={c.updateAppSetting}
                onUpdateAccountSetting={c.updateAccountSetting}
                onReorderAccounts={c.onReorderAccounts}
                onAddAccount={c.accounts.addAccount}
                onReconnect={c.accounts.reconnectActions}
                onSignOut={c.accounts.requestRemoveAccount}
                focusControl={c.settingsFocus}
              />
            )}
            <div
              className={`min-w-0 flex-1 flex-col ${c.settingsOpen ? 'hidden' : 'flex'}`}
              aria-hidden={c.settingsOpen || undefined}
            >
              <MailboxTop controller={c} />
              <MailboxBody controller={c} />
            </div>
          </div>

          {/* A full-window composer brings its own footer, and Settings is not a
              mailbox: neither wants the list's shortcuts or its sync line. */}
          {!c.fullWindowComposerDraft && !c.settingsOpen && (
            <MailFooter
              context={
                c.inlineComposerDraft
                  ? 'composer'
                  : c.searchOpen && c.search.keyboardTarget === 'query' && !c.readerOpen
                    ? 'search'
                    : c.readerOpen
                      ? 'reader'
                      : !c.searchOpen && c.view === 'outbox'
                        ? 'outbox'
                        : 'list'
              }
              pendingChord={c.pendingChord}
              sync={c.sync}
              networkOnline={c.networkOnline}
              onRetry={c.retrySync}
              onCopyError={c.copySyncError}
            />
          )}
        </div>
      </div>

      <InboxOverlays controller={c} />
    </div>
  )
}

/** Rows the keyboard has checked, only in the views that can check them. */
function selectedForCount(c: InboxController): number {
  if (c.fullWindowComposerDraft) return 0
  return c.searchOpen || (c.view !== 'drafts' && c.view !== 'outbox') ? c.selectedIds.size : 0
}

function MailboxTop({ controller: c }: { controller: InboxController }): React.JSX.Element | null {
  if (c.readerOpen || c.fullWindowComposerDraft) return null
  return (
    <>
      {c.searchOpen ? (
        <SearchHeader
          inputRef={c.search.inputRef}
          query={c.searchQuery}
          pending={c.search.local.pending}
          onQuery={c.setSearchQuery}
          onClear={c.clearSearch}
          onFocusQuery={c.focusSearchQuery}
          onSubmit={c.search.submit}
        />
      ) : (
        <div
          data-testid="mail-view-header"
          className="app-drag flex h-[68px] flex-none items-baseline gap-5 pt-4 pr-7 pl-[60px]"
        >
          <h1 data-testid="mailbox-title" className="font-serif text-[44px] leading-none text-ink">
            <span data-testid="view-title">
              <ViewTitle title={c.activeViewTitle} />
            </span>
          </h1>
          <span data-testid="view-count" className="app-figures flex-none text-[16px] text-ink-faint">
            {`${c.conversationThreadCount.toLocaleString()}${c.conversationThreadCountExact ? '' : '+'} ${
              c.conversationThreadCount === 1 ? 'conversation' : 'conversations'
            }`}
          </span>
        </div>
      )}
      {!c.searchOpen && (
        <SplitStrip
          splits={c.view === 'inbox' ? (c.splits.state?.splits ?? []) : []}
          activeSplitId={c.splits.activeSplitId}
          onSelect={c.switchSplit}
          onManage={() => c.setSplitRulesOpen(true)}
          onOpenSearch={c.openSearch}
        />
      )}
    </>
  )
}

function MailboxBody({ controller: c }: { controller: InboxController }): React.JSX.Element {
  return (
    <div className={`flex min-h-0 flex-1 ${c.searchOpen && !c.readerOpen ? 'flex-col' : ''}`}>
      {c.searchDraftMode ? (
        <DraftList
          drafts={c.search.drafts}
          readerOpen={false}
          selectedIndex={c.selectedIndex}
          selectionVisible={c.search.keyboardTarget === 'results'}
          selectedRowRef={c.selectedRowRef}
          listRef={c.listElRef}
          onOpen={(index) => {
            c.search.focusResults()
            c.setSelectedIndex(index)
            const draft = c.search.drafts[index]
            if (draft) c.reopenListDraft(draft.id)
          }}
        />
      ) : !c.searchOpen && c.view === 'drafts' ? (
        <DraftList
          drafts={c.realDrafts}
          readerOpen={c.readerOpen}
          selectedIndex={c.selectedIndex}
          selectedRowRef={c.selectedRowRef}
          listRef={c.listElRef}
          onOpen={(index) => {
            c.setSelectedIndex(index)
            const draft = c.realDrafts[index]
            if (!draft) return
            c.selectedDraftIdRef.current = draft.id
            c.reopenListDraft(draft.id)
          }}
        />
      ) : !c.searchOpen && c.view === 'outbox' ? (
        <OutboxList
          items={c.realOutbox}
          selectedIndex={c.selectedIndex}
          selectedRowRef={c.selectedRowRef}
          listRef={c.listElRef}
          onOpen={(index) => {
            c.setSelectedIndex(index)
            c.selectedDraftIdRef.current = c.realOutbox[index]?.id ?? null
            c.openOutboxItem(index)
          }}
        />
      ) : c.showInboxZero && c.splits.state && c.splits.activeSplitId ? (
        <InboxZero
          activeSplitId={c.splits.activeSplitId}
          splits={c.splits.state.splits}
          listRef={c.listElRef}
          onSelectSplit={c.switchSplit}
        />
      ) : (
        <ThreadList
          threads={c.threads}
          view={c.searchOpen ? 'search' : threadListKind(c.view)}
          hasMore={!c.searchOpen && c.activePageState?.nextCursor !== null && c.activePageState !== undefined}
          loadingMore={!c.searchOpen && (c.activePageState?.loadingMore ?? false)}
          loadingInitial={
            !c.searchOpen &&
            (c.view === 'inbox'
              ? !c.activeInboxRowsResolved || c.inboxBackfillReady !== true
              : !c.viewRowsLoaded)
          }
          syncing={!c.searchOpen && c.sync.phase === 'syncing'}
          readerOpen={c.readerOpen}
          selectedIndex={c.selectedIndex}
          selectionVisible={!c.searchOpen || c.search.keyboardTarget === 'results'}
          selectedIds={c.selectedIds}
          exitingThreadIds={c.exitingThreadIds}
          labelsById={c.userLabelsById}
          selectedRowRef={c.selectedRowRef}
          listRef={c.listElRef}
          onExtendSelection={c.extendSelectionTo}
          onLoadMore={c.loadMoreVisibleThreads}
          onOpenLabel={c.openLabelView}
          onOpen={c.openThreadFromList}
          sectionDivider={c.searchOpen ? c.search.sectionDivider : undefined}
        />
      )}

      <SearchStatus controller={c} />

      {c.readerOpen && c.selected && (
        <ConversationView
          selected={c.selected}
          selectedIndex={c.conversationSelectedIndex}
          threadCount={c.conversationThreadCount}
          threadCountExact={c.conversationThreadCountExact}
          conversation={c.conversation}
          account={c.activeAccount}
          online={c.online}
          scrollRef={c.conversationScrollRef}
          replyTargetRef={c.messageReplyTargetRef}
          inlineComposer={c.drafting.inlineComposer}
          inlineComposerDraftId={c.inlineComposerDraft?.id ?? null}
          inlineComposerSourceMessageId={c.inlineComposerDraft?.sourceMessageId ?? null}
          onReply={c.openReply}
        />
      )}
    </div>
  )
}

function SearchStatus({ controller: c }: { controller: InboxController }): React.JSX.Element | null {
  if (!c.searchOpen || c.readerOpen || !c.searchQuery.trim()) return null
  return (
    <>
      {!c.searchDraftMode && !c.search.snoozeMode && (
        <ServerSearchRow
          phase={c.search.server.phase}
          resultCount={c.search.server.resultCount}
          message={c.search.server.message}
          quotaWaitMs={c.search.server.quotaWaitMs}
          online={c.online}
        />
      )}
      <div
        data-testid="search-coverage"
        data-search-query={c.search.local.completedQuery ?? undefined}
        role={c.search.local.failed ? 'alert' : 'status'}
        data-partial={c.search.local.response?.partial || undefined}
        className={`flex h-8 flex-none items-center border-t border-edge px-7 text-[11px] ${
          c.search.local.response?.partial ? 'text-accent' : 'text-ink-faint'
        }`}
      >
        {c.search.local.failed
          ? 'Local search could not be completed'
          : c.search.local.response
            ? searchCoverageText(c.search.local.response.coverage, c.search.local.response.partial)
            : 'Searching cached mail…'}
      </div>
    </>
  )
}
