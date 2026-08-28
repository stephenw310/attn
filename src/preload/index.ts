import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { formatActionRevertToast } from '../shared/actionRevert'
import type { TriageAction, TriageResult } from '../shared/actions'
import type { AuthSignInResult, AuthStatus } from '../shared/auth'
import type { CommandUsage } from '../shared/commandUsage'
import type { ContactSearchResult } from '../shared/contacts'
import type {
  Draft,
  DraftAttachmentMutationResult,
  DraftInlineImageInput,
  DraftInlineImageResult,
  DraftKind,
  DraftSaveInput
} from '../shared/drafts'
import { nonEmptyString } from '../shared/guards'
import { type InvokeChannel, type InvokeChannels, IPC_CHANNELS, type MailChangeReason } from '../shared/ipc'
import type {
  Conversation,
  ConversationMailbox,
  DownloadAttachmentRequest,
  DownloadAttachmentResult,
  InlineImageRepairRequest,
  InlineImageRequest,
  InlineImageResult,
  MailLabel,
  SnoozedThreadRow,
  SyncState,
  SystemMailboxCounts,
  ThreadListRequest,
  ThreadListView,
  ThreadPage,
  ThreadPageCursor,
  ThreadRow
} from '../shared/mail'
import type {
  OutboxChanged,
  OutboxItem,
  OutboxProgress,
  QueueSendResult,
  ReopenOutboxResult
} from '../shared/outbox'
import type { SearchResponse, ServerSearchResponse } from '../shared/searchQuery'
import type {
  ReorderSplitsInput,
  SaveSplitInput,
  SplitPresetId,
  SplitState,
  SplitThreadLocation
} from '../shared/splits'
import { isThemePreference, type ThemePreference } from '../shared/theme'
import { subscribeToActionReverts } from './actionRevertDelivery'

const THEME_ARGUMENT_PREFIX = '--attn-theme='
const themeArgument = process.argv.find((argument) => argument.startsWith(THEME_ARGUMENT_PREFIX))
const themeCandidate = themeArgument?.slice(THEME_ARGUMENT_PREFIX.length)
const initialTheme: ThemePreference = isThemePreference(themeCandidate) ? themeCandidate : 'system'

function invoke<K extends InvokeChannel>(
  channel: K,
  ...args: InvokeChannels[K]['args']
): Promise<InvokeChannels[K]['result']> {
  return ipcRenderer.invoke(channel, ...args)
}

function listThreadPage(request: ThreadListRequest): Promise<ThreadPage> {
  return invoke(IPC_CHANNELS.mailListThreads, request)
}

const api = {
  platform: process.platform,
  auth: {
    getStatus: (): Promise<AuthStatus> => invoke(IPC_CHANNELS.authGetStatus),
    signIn: (): Promise<AuthSignInResult> => invoke(IPC_CHANNELS.authSignIn),
    signOut: (): Promise<AuthStatus> => invoke(IPC_CHANNELS.authSignOut)
  },
  settings: {
    initialTheme,
    getTheme: (): Promise<ThemePreference> => invoke(IPC_CHANNELS.settingsGetTheme),
    setTheme: (preference: ThemePreference): Promise<ThemePreference> =>
      invoke(IPC_CHANNELS.settingsSetTheme, preference),
    getCommandUsage: (accountId: string): Promise<CommandUsage> =>
      invoke(IPC_CHANNELS.settingsGetCommandUsage, accountId),
    setCommandUsage: (accountId: string, usage: CommandUsage): Promise<CommandUsage> =>
      invoke(IPC_CHANNELS.settingsSetCommandUsage, accountId, usage)
  },
  mail: {
    search: (query: string): Promise<SearchResponse> => invoke(IPC_CHANNELS.mailSearch, query),
    searchAll: (requestId: string, query: string): Promise<ServerSearchResponse> =>
      invoke(IPC_CHANNELS.mailSearchAll, requestId, query),
    cancelSearchAll: (requestId: string): Promise<void> =>
      invoke(IPC_CHANNELS.mailCancelSearchAll, requestId),
    listThreadPage: (
      view: Exclude<ThreadListView, 'snoozed'>,
      cursor?: ThreadPageCursor,
      splitId?: string
    ): Promise<ThreadPage> =>
      listThreadPage({
        view,
        ...(cursor ? { cursor } : {}),
        ...(view === 'inbox' && splitId ? { splitId } : {})
      }),
    listLabelThreadPage: (labelId: string, cursor?: ThreadPageCursor): Promise<ThreadPage> =>
      listThreadPage({ view: 'label', labelId, ...(cursor ? { cursor } : {}) }),
    listSnoozedPage: (cursor?: ThreadPageCursor): Promise<ThreadPage<SnoozedThreadRow>> =>
      listThreadPage({ view: 'snoozed', ...(cursor ? { cursor } : {}) }) as Promise<
        ThreadPage<SnoozedThreadRow>
      >,
    listThreads: (view: Exclude<ThreadListView, 'snoozed'>): Promise<ThreadRow[]> =>
      listThreadPage({ view }).then((page) => page.rows),
    listLabelThreads: (labelId: string): Promise<ThreadRow[]> =>
      listThreadPage({ view: 'label', labelId }).then((page) => page.rows),
    // The one typed read serves Snoozed too; only that view returns reminder rows.
    listSnoozed: (): Promise<SnoozedThreadRow[]> =>
      listThreadPage({ view: 'snoozed' }).then((page) => page.rows as SnoozedThreadRow[]),
    listLabels: (): Promise<MailLabel[]> => invoke(IPC_CHANNELS.mailListLabels),
    getMailboxCounts: (): Promise<SystemMailboxCounts> => invoke(IPC_CHANNELS.mailGetMailboxCounts),
    getUnreadCount: (): Promise<number> => invoke(IPC_CHANNELS.mailGetUnreadCount),
    getConversation: (
      threadId: string,
      allowHydration: boolean,
      mailbox: ConversationMailbox
    ): Promise<Conversation | null> =>
      invoke(IPC_CHANNELS.mailGetConversation, threadId, allowHydration, mailbox),
    downloadAttachment: (request: DownloadAttachmentRequest): Promise<DownloadAttachmentResult> =>
      invoke(IPC_CHANNELS.mailDownloadAttachment, request),
    getInlineImage: (request: InlineImageRequest): Promise<InlineImageResult> =>
      invoke(IPC_CHANNELS.mailGetInlineImage, request),
    repairInlineImages: (request: InlineImageRepairRequest): Promise<boolean> =>
      invoke(IPC_CHANNELS.mailRepairInlineImages, request),
    triage: (action: TriageAction): Promise<TriageResult> => invoke(IPC_CHANNELS.mailTriage, action),
    snooze: (threadIds: string[], dueAt: number): Promise<TriageResult> =>
      invoke(IPC_CHANNELS.mailSnooze, { threadIds, dueAt }),
    markReadOnOpen: (threadId: string): Promise<void> => invoke(IPC_CHANNELS.mailMarkReadOnOpen, threadId),
    undo: (): Promise<TriageResult | null> => invoke(IPC_CHANNELS.mailUndo),
    getPendingActionCount: (): Promise<number> => invoke(IPC_CHANNELS.mailGetPendingActionCount),
    getActionQueueStatus: () => invoke(IPC_CHANNELS.mailGetActionQueueStatus),
    onChanged: (
      cb: (serverSearchRequestId: string | null, reason: MailChangeReason | null) => void
    ): (() => void) => {
      const listener = (
        _event: unknown,
        payload: { serverSearchRequestId?: unknown; reason?: unknown } | undefined
      ): void =>
        cb(
          typeof payload?.serverSearchRequestId === 'string' ? payload.serverSearchRequestId : null,
          payload?.reason === 'split-metadata' ? payload.reason : null
        )
      ipcRenderer.on(IPC_CHANNELS.mailChanged, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.mailChanged, listener)
    },
    onActionsReverted: (accountId: string, cb: (message: string) => void | Promise<void>): (() => void) =>
      subscribeToActionReverts(
        accountId,
        {
          peek: (requestedAccountId) => invoke(IPC_CHANNELS.mailPeekActionsReverted, requestedAccountId),
          acknowledge: (requestedAccountId, noticeId) =>
            invoke(IPC_CHANNELS.mailAcknowledgeActionsReverted, requestedAccountId, noticeId),
          onAvailable: (listener) => {
            ipcRenderer.on(IPC_CHANNELS.mailActionsReverted, listener)
            return () => ipcRenderer.removeListener(IPC_CHANNELS.mailActionsReverted, listener)
          },
          isVisible: () => document.visibilityState === 'visible',
          onVisibilityChange: (listener) => {
            document.addEventListener('visibilitychange', listener)
            return () => document.removeEventListener('visibilitychange', listener)
          }
        },
        (actions) => {
          const message = formatActionRevertToast(actions)
          return message ? cb(message) : undefined
        }
      ),
    onBodyHydrationFailed: (cb: (accountId: string, threadId: string) => void): (() => void) => {
      const listener = (_event: unknown, payload: { accountId: string; threadId: string }): void =>
        cb(payload.accountId, payload.threadId)
      ipcRenderer.on(IPC_CHANNELS.mailBodyHydrationFailed, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.mailBodyHydrationFailed, listener)
    },
    onFocusThread: (cb: (threadId: string) => void): (() => void) => {
      let active = true
      const takePendingFocus = async (): Promise<void> => {
        let threadId: string | null = null
        try {
          threadId = await invoke(IPC_CHANNELS.mailTakePendingFocus)
        } catch {
          // App shutdown can race the best-effort pending-focus pull after the
          // main process has already removed its IPC handlers.
          return
        }
        if (active && nonEmptyString(threadId)) cb(threadId)
      }
      const listener = (): void => void takePendingFocus()
      ipcRenderer.on(IPC_CHANNELS.mailFocusThreadAvailable, listener)
      // A newly-created renderer may miss the availability signal while it is
      // mounting, so it always pulls the pending target after subscribing.
      void takePendingFocus()
      return () => {
        active = false
        ipcRenderer.removeListener(IPC_CHANNELS.mailFocusThreadAvailable, listener)
      }
    }
  },
  splits: {
    getState: (): Promise<SplitState> => invoke(IPC_CHANNELS.splitsGetState),
    getThreadLocation: (threadId: string): Promise<SplitThreadLocation | null> =>
      invoke(IPC_CHANNELS.splitsGetThreadLocation, threadId),
    save: (input: SaveSplitInput): Promise<SplitState> => invoke(IPC_CHANNELS.splitsSave, input),
    setNotify: (id: string, notify: boolean): Promise<SplitState> =>
      invoke(IPC_CHANNELS.splitsSetNotify, id, notify),
    delete: (id: string): Promise<SplitState> => invoke(IPC_CHANNELS.splitsDelete, id),
    reorder: (input: ReorderSplitsInput): Promise<SplitState> => invoke(IPC_CHANNELS.splitsReorder, input),
    restorePreset: (id: SplitPresetId): Promise<SplitState> => invoke(IPC_CHANNELS.splitsRestorePreset, id)
  },
  contacts: {
    search: (query: string): Promise<ContactSearchResult[]> => invoke(IPC_CHANNELS.contactsSearch, query)
  },
  draft: {
    save: (draft: DraftSaveInput): Promise<{ id: string; draft: Draft | null }> =>
      invoke(IPC_CHANNELS.draftSave, draft),
    get: (id: string): Promise<Draft | null> => invoke(IPC_CHANNELS.draftGet, id),
    list: (): Promise<Draft[]> => invoke(IPC_CHANNELS.draftList),
    reopen: (id: string): Promise<Draft | null> => invoke(IPC_CHANNELS.draftReopen, id),
    createReply: (
      threadId: string,
      kind: Exclude<DraftKind, 'new'>,
      mailbox: ConversationMailbox = 'normal'
    ): Promise<Draft | null> => invoke(IPC_CHANNELS.draftCreateReply, threadId, kind, mailbox),
    pickAttachments: (id: string): Promise<DraftAttachmentMutationResult> =>
      invoke(IPC_CHANNELS.draftPickAttachments, id),
    addDroppedFiles: (id: string, files: File[]): Promise<DraftAttachmentMutationResult> =>
      invoke(
        IPC_CHANNELS.draftAddAttachments,
        id,
        files.map((file) => webUtils.getPathForFile(file)).filter(Boolean)
      ),
    removeAttachment: (id: string, attachmentId: string): Promise<DraftAttachmentMutationResult> =>
      invoke(IPC_CHANNELS.draftRemoveAttachment, id, attachmentId),
    addInlineImage: (id: string, image: DraftInlineImageInput): Promise<DraftInlineImageResult> =>
      invoke(IPC_CHANNELS.draftAddInlineImage, id, image),
    getInlineImage: (id: string, contentId: string): Promise<InlineImageResult> =>
      invoke(IPC_CHANNELS.draftGetInlineImage, id, contentId),
    close: (id: string): Promise<'saved' | 'discarded'> => invoke(IPC_CHANNELS.draftClose, id),
    discard: (id: string, expectedState: 'composing' | 'drafted' = 'composing'): Promise<void> =>
      invoke(IPC_CHANNELS.draftDiscard, id, expectedState),
    mirror: (id: string): Promise<void> => invoke(IPC_CHANNELS.draftMirror, id),
    takeRecovered: (): Promise<Draft | null> => invoke(IPC_CHANNELS.draftTakeRecovered)
  },
  outbox: {
    send: (draftId: string): Promise<QueueSendResult> => invoke(IPC_CHANNELS.outboxSend, draftId),
    undoSend: (outboxId: string): Promise<ReopenOutboxResult> =>
      invoke(IPC_CHANNELS.outboxUndoSend, outboxId),
    reopen: (outboxId: string): Promise<ReopenOutboxResult> => invoke(IPC_CHANNELS.outboxReopen, outboxId),
    listPending: (): Promise<OutboxItem[]> => invoke(IPC_CHANNELS.outboxListPending),
    onChanged: (cb: (change: OutboxChanged) => void): (() => void) => {
      const listener = (_event: unknown, change: OutboxChanged): void => cb(change)
      ipcRenderer.on(IPC_CHANNELS.outboxChanged, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.outboxChanged, listener)
    },
    onProgress: (cb: (progress: OutboxProgress | null) => void): (() => void) => {
      const listener = (_event: unknown, progress: OutboxProgress | null): void => cb(progress)
      ipcRenderer.on(IPC_CHANNELS.outboxProgress, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.outboxProgress, listener)
    }
  },
  sync: {
    getState: (): Promise<SyncState> => invoke(IPC_CHANNELS.syncGetState),
    retry: (): Promise<void> => invoke(IPC_CHANNELS.syncRetry),
    onState: (cb: (s: SyncState) => void): (() => void) => {
      const listener = (_e: unknown, s: SyncState): void => cb(s)
      ipcRenderer.on(IPC_CHANNELS.syncState, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.syncState, listener)
    }
  }
}

contextBridge.exposeInMainWorld('attn', api)

export type AttnApi = typeof api
