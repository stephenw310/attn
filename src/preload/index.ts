import { contextBridge, ipcRenderer, webUtils } from 'electron'
import { formatActionRevertToast } from '../shared/actionRevert'
import type { TriageAction, TriageResult } from '../shared/actions'
import type { AiGenerateRequest, AiSettingKey, AiSettings, AiStreamEvent } from '../shared/ai'
import type { AccountSyncStatus, AuthSignInResult, AuthStatus } from '../shared/auth'
import type { CommandUsage } from '../shared/commandUsage'
import type { ContactSearchResult } from '../shared/contacts'
import type { AppInfo, UpdateState } from '../shared/distribution'
import type {
  Draft,
  DraftAttachmentMutationResult,
  DraftInlineImageInput,
  DraftInlineImageResult,
  DraftKind,
  DraftSaveInput
} from '../shared/drafts'
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
  ThreadPageCursor
} from '../shared/mail'
import type { PendingFocusTarget } from '../shared/notifications'
import type {
  OutboxChanged,
  OutboxItem,
  OutboxProgress,
  QueueSendResult,
  ReopenOutboxResult
} from '../shared/outbox'
import type { SearchResponse, ServerSearchResponse } from '../shared/searchQuery'
import type { AccountSettingKey, AccountSettings, AppSettingKey, AppSettings } from '../shared/settings'
import type { Snippet, SnippetSaveInput } from '../shared/snippets'
import type {
  ReorderSplitsInput,
  SaveSplitInput,
  SplitPresetId,
  SplitState,
  SplitThreadLocation
} from '../shared/splits'
import { isThemePreference, type ThemePreference } from '../shared/theme'
import { subscribeToActionReverts } from './actionRevertDelivery'

/** Open composers awaiting a pre-quit checkpoint request (B28). */
const checkpointSubscribers = new Set<() => Promise<void> | void>()

ipcRenderer.on(IPC_CHANNELS.draftCheckpointRequest, (_event, payload: { requestId: number }) => {
  const commits = [...checkpointSubscribers].map(async (commit) => {
    try {
      await commit()
    } catch {
      // A failed checkpoint must not hold up the quit; the draft keeps its
      // last successful revision, exactly as an autosave failure leaves it.
    }
  })
  void Promise.all(commits).then(() =>
    // Answering is best effort: main may already have torn its handlers down.
    ipcRenderer.invoke(IPC_CHANNELS.draftCheckpointDone, payload.requestId).catch(() => {})
  )
})

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
  /** True only under the e2e harness (ATTN_TEST_USER_DATA); gates renderer test seams. */
  testMode: process.argv.includes('--attn-test-mode'),
  auth: {
    getStatus: (): Promise<AuthStatus> => invoke(IPC_CHANNELS.authGetStatus),
    signIn: (): Promise<AuthSignInResult> => invoke(IPC_CHANNELS.authSignIn),
    setActiveAccount: (accountId: string): Promise<AuthStatus> =>
      invoke(IPC_CHANNELS.accountsSetActive, accountId),
    removeAccount: (accountId: string, deleteData: boolean): Promise<AuthStatus> =>
      invoke(IPC_CHANNELS.accountsRemove, accountId, deleteData),
    reorderAccounts: (accountIds: string[]): Promise<AuthStatus> =>
      invoke(IPC_CHANNELS.accountsReorder, accountIds),
    getAccountStatuses: (): Promise<AccountSyncStatus[]> => invoke(IPC_CHANNELS.accountsGetStatuses),
    onAccountStatuses: (cb: (statuses: AccountSyncStatus[]) => void): (() => void) => {
      const listener = (_event: unknown, statuses: AccountSyncStatus[]): void => cb(statuses)
      ipcRenderer.on(IPC_CHANNELS.accountsStatusChanged, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.accountsStatusChanged, listener)
    }
  },
  settings: {
    initialTheme,
    setTheme: (preference: ThemePreference): Promise<ThemePreference> =>
      invoke(IPC_CHANNELS.settingsSetTheme, preference),
    getCommandUsage: (accountId: string): Promise<CommandUsage> =>
      invoke(IPC_CHANNELS.settingsGetCommandUsage, accountId),
    setCommandUsage: (accountId: string, usage: CommandUsage): Promise<CommandUsage> =>
      invoke(IPC_CHANNELS.settingsSetCommandUsage, accountId, usage),
    getAll: (): Promise<AppSettings> => invoke(IPC_CHANNELS.settingsGetAll),
    set: <K extends AppSettingKey>(key: K, value: AppSettings[K]): Promise<AppSettings> =>
      invoke(IPC_CHANNELS.settingsSet, key, value),
    getAccount: (accountId: string): Promise<AccountSettings> =>
      invoke(IPC_CHANNELS.settingsGetAccount, accountId),
    setAccount: <K extends AccountSettingKey>(
      accountId: string,
      key: K,
      value: AccountSettings[K]
    ): Promise<AccountSettings> => invoke(IPC_CHANNELS.settingsSetAccount, accountId, key, value)
  },
  snippets: {
    list: (): Promise<Snippet[]> => invoke(IPC_CHANNELS.snippetsList),
    save: (input: SnippetSaveInput): Promise<Snippet[]> => invoke(IPC_CHANNELS.snippetsSave, input),
    remove: (id: string): Promise<Snippet[]> => invoke(IPC_CHANNELS.snippetsDelete, id)
  },
  ai: {
    getSettings: (): Promise<AiSettings> => invoke(IPC_CHANNELS.aiGetSettings),
    setSetting: <K extends AiSettingKey>(key: K, value: AiSettings[K]): Promise<AiSettings> =>
      invoke(IPC_CHANNELS.aiSetSetting, key, value),
    setKey: (key: string): Promise<AiSettings> => invoke(IPC_CHANNELS.aiSetKey, key),
    deleteKey: (): Promise<AiSettings> => invoke(IPC_CHANNELS.aiDeleteKey),
    generate: (request: AiGenerateRequest): Promise<{ requestId: string }> =>
      invoke(IPC_CHANNELS.aiGenerate, request),
    cancel: (requestId: string): Promise<void> => invoke(IPC_CHANNELS.aiCancel, requestId),
    styleExamples: (excludeThreadId: string): Promise<string[]> =>
      invoke(IPC_CHANNELS.aiStyleExamples, excludeThreadId),
    onStreamEvent: (cb: (event: AiStreamEvent) => void): (() => void) => {
      const listener = (_event: unknown, payload: AiStreamEvent): void => cb(payload)
      ipcRenderer.on(IPC_CHANNELS.aiStreamEvent, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.aiStreamEvent, listener)
    }
  },
  mail: {
    findThreadInView: (request: ThreadListRequest, threadId: string): Promise<ThreadPage> =>
      listThreadPage({ ...request, cursor: undefined, threadId }),
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
    registerMessageFrame: (
      nonce: string,
      messageId: string
    ): Promise<{ blocked: boolean; imagesAllowed: boolean }> =>
      invoke(IPC_CHANNELS.mailRegisterMessageFrame, nonce, messageId),
    unregisterMessageFrame: (nonce: string): Promise<void> =>
      invoke(IPC_CHANNELS.mailUnregisterMessageFrame, nonce),
    // The `Load once` gesture, recorded in main against the nonce the reader
    // is about to register: a registration cannot allow itself (T33).
    allowRemoteImagesOnce: (nonce: string, messageId: string): Promise<void> =>
      invoke(IPC_CHANNELS.mailAllowRemoteImagesOnce, nonce, messageId),
    allowRemoteImagesFromSender: (messageId: string): Promise<{ sender: string; overrides: string[] }> =>
      invoke(IPC_CHANNELS.mailAllowRemoteImagesFromSender, messageId),
    listRemoteImageOverrides: (): Promise<string[]> => invoke(IPC_CHANNELS.mailListRemoteImageOverrides),
    removeRemoteImageOverride: (address: string): Promise<string[]> =>
      invoke(IPC_CHANNELS.mailRemoveRemoteImageOverride, address),
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
    onRemoteImagesChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on(IPC_CHANNELS.mailRemoteImagesChanged, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.mailRemoteImagesChanged, listener)
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
    onFocusThread: (cb: (target: PendingFocusTarget) => void): (() => void) => {
      let active = true
      const takePendingFocus = async (): Promise<void> => {
        let target: PendingFocusTarget | null = null
        try {
          target = await invoke(IPC_CHANNELS.mailTakePendingFocus)
        } catch {
          // App shutdown can race the best-effort pending-focus pull after the
          // main process has already removed its IPC handlers.
          return
        }
        if (active && target) cb(target)
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
    },
    /**
     * Clear a delivered focus target after the right account's tree accepted
     * it. Until this lands, main keeps the target pending so a delivery that
     * died in a torn-down subscription cannot lose the notification click.
     */
    acknowledgeFocusThread: (id: number): Promise<void> =>
      invoke(IPC_CHANNELS.mailAcknowledgePendingFocus, id)
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
      mailbox: ConversationMailbox = 'normal',
      sourceMessageId?: string
    ): Promise<Draft | null> =>
      invoke(IPC_CHANNELS.draftCreateReply, threadId, kind, mailbox, sourceMessageId),
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
    takeRecovered: (): Promise<Draft | null> => invoke(IPC_CHANNELS.draftTakeRecovered),
    /**
     * Commit before quit (B28). Main asks while the document is still alive
     * and waits for the answer, so the last second of typing reaches SQLite.
     * The subscription list lives here rather than in the tree: main must get
     * an answer even when no composer is mounted, or every quit would wait out
     * its timeout.
     */
    onCheckpointRequest: (cb: () => Promise<void> | void): (() => void) => {
      checkpointSubscribers.add(cb)
      return () => {
        checkpointSubscribers.delete(cb)
      }
    }
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
  app: {
    getInfo: (): Promise<AppInfo> => invoke(IPC_CHANNELS.appGetInfo)
  },
  update: {
    getState: (): Promise<UpdateState> => invoke(IPC_CHANNELS.updateGetState),
    check: (): Promise<UpdateState> => invoke(IPC_CHANNELS.updateCheck),
    restart: (): Promise<boolean> => invoke(IPC_CHANNELS.updateRestart),
    onState: (cb: (state: UpdateState) => void): (() => void) => {
      const listener = (_event: unknown, state: UpdateState): void => cb(state)
      ipcRenderer.on(IPC_CHANNELS.updateState, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.updateState, listener)
    }
  },
  sync: {
    getState: (): Promise<SyncState> => invoke(IPC_CHANNELS.syncGetState),
    getInboxReady: (): Promise<boolean> => invoke(IPC_CHANNELS.syncGetInboxReady),
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
