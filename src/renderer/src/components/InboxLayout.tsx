import type { ThreadListView } from '../../../shared/mail'
import type { InboxController } from '../hooks/useInboxController'
import { type MailView, userLabelId } from '../list/mailDisplay'
import { ConversationView } from './ConversationView'
import { DraftList } from './DraftList'
import { InboxOverlays } from './InboxOverlays'
import { InboxZero } from './InboxZero'
import { MailFooter } from './MailFooter'
import { MailHeader } from './MailHeader'
import { MailSidebar } from './MailSidebar'
import { OutboxList } from './OutboxList'
import { QuickTooltip } from './QuickTooltip'
import { SearchHeader, searchCoverageText } from './SearchHeader'
import { ServerSearchRow } from './ServerSearchRow'
import { SettingsView } from './SettingsView'
import { SplitStrip } from './SplitStrip'
import { SyncStatus } from './SyncStatus'
import { ThreadList } from './ThreadList'

function threadListKind(view: MailView): ThreadListView | 'label' {
  if (userLabelId(view)) return 'label'
  if (view !== 'drafts' && view !== 'outbox') return view as ThreadListView
  return 'inbox'
}

export function InboxLayout({ controller: c }: { controller: InboxController }): React.JSX.Element {
  return (
    <div className="flex h-full flex-col">
      <MailHeader
        preferencesOpen={c.settingsOpen || c.splitRulesOpen}
        pendingActionCount={c.pendingActionCount}
        pausedActionCount={c.pausedActionCount}
        outboxCount={c.realOutbox.length}
        selectionCount={c.searchOpen || (c.view !== 'drafts' && c.view !== 'outbox') ? c.selectedIds.size : 0}
        composerOpen={c.fullWindowComposerDraft !== null}
        sidebarCollapsed={c.sidebarCollapsed}
        footerCollapsed={c.footerCollapsed}
        onToggleFooter={c.toggleFooter}
        syncStatus={
          <SyncStatus
            sync={c.sync}
            networkOnline={c.networkOnline}
            onRetry={c.retrySync}
            onCopyError={c.copySyncError}
          />
        }
        status={c.status}
        accountStatuses={c.accounts.accountStatuses}
        onReconnectActions={c.accounts.reconnectActions}
        onOpenOutbox={c.openOutbox}
        onToggleSidebar={c.toggleSidebar}
        onWrite={c.drafting.openComposer}
        writeDisabled={c.accountActionsBlocked}
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
        {!c.sidebarCollapsed && !c.settingsOpen && !c.splitRulesOpen && (
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
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
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
              onOpenSplits={() => {
                c.closeSettings()
                c.setSplitRulesOpen(true)
              }}
              onClose={c.closeSettings}
              focusControl={c.settingsFocus}
              onNavigate={c.clearSettingsFocus}
            />
          )}
          <div
            className={`app-mail-content min-h-0 min-w-0 flex-1 flex-col ${c.settingsOpen ? 'hidden' : 'flex'}`}
            aria-hidden={c.settingsOpen || undefined}
          >
            <MailboxTop controller={c} />
            <SearchStatus controller={c} />
            <MailboxBody controller={c} />
          </div>
          {!c.fullWindowComposerDraft && !c.footerCollapsed && !c.settingsOpen && !c.splitRulesOpen && (
            <MailFooter
              onOpenShortcuts={c.openCheatSheet}
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
            />
          )}
        </div>
      </div>

      <InboxOverlays controller={c} />
      <QuickTooltip />
    </div>
  )
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
        <div data-testid="mail-view-header" className="app-inbox-header flex-none">
          <h1 data-testid="mailbox-title" className="text-ink">
            <span data-testid="view-title">{c.activeViewTitle}</span>
          </h1>
          {c.view === 'inbox' && c.splits.state && (
            <SplitStrip
              splits={c.splits.state.splits}
              activeSplitId={c.splits.activeSplitId}
              onSelect={c.switchSplit}
              onManage={() => c.setSplitRulesOpen(true)}
            />
          )}
          <button
            type="button"
            data-testid="search-open"
            aria-label="Search mail"
            data-tooltip="Search mail (/)"
            onClick={c.openSearch}
            className="app-no-drag col-start-2 row-start-1 ml-auto flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 text-xs text-ink-faint hover:bg-active hover:text-ink"
          >
            <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 fill-none stroke-current">
              <circle cx="10.5" cy="10.5" r="6.5" strokeWidth="1.8" />
              <path d="m15.5 15.5 4 4" strokeWidth="1.8" strokeLinecap="round" />
            </svg>
            <span>Search</span>
          </button>
        </div>
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

      {c.readerOpen && c.selected && (
        <ConversationView
          selected={c.selected}
          selectedIndex={c.conversationSelectedIndex}
          threadCount={c.conversationThreadCount}
          threadCountExact={c.conversationThreadCountExact}
          mailboxTitle={c.searchOpen ? 'Search' : c.activeViewTitle}
          conversation={c.conversation}
          labels={c.labels}
          onOpenLabel={c.openLabelView}
          account={c.activeAccount}
          online={c.online}
          scrollRef={c.conversationScrollRef}
          replyTargetRef={c.messageReplyTargetRef}
          inlineComposer={c.drafting.inlineComposer}
          inlineComposerDraftId={c.inlineComposerDraft?.id ?? null}
          inlineComposerSourceMessageId={c.inlineComposerDraft?.sourceMessageId ?? null}
          onReply={c.openReply}
          onClose={c.closeReader}
        />
      )}
    </div>
  )
}

function SearchStatus({ controller: c }: { controller: InboxController }): React.JSX.Element | null {
  if (!c.searchOpen || c.readerOpen || !c.searchQuery.trim()) return null
  return (
    <div
      data-testid="search-status"
      className="flex flex-none flex-wrap items-center justify-between gap-x-6 gap-y-1 px-7 py-2 text-ink-faint"
    >
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
        className={`min-w-0 text-[11px] ${
          c.search.local.response?.partial ? 'text-accent' : 'text-ink-faint'
        }`}
      >
        {c.search.local.failed
          ? 'Local search could not be completed'
          : c.search.local.response
            ? searchCoverageText(c.search.local.response.coverage, c.search.local.response.partial)
            : 'Searching cached mail…'}
      </div>
    </div>
  )
}
