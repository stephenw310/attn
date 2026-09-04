import type { ActionRevertNotice } from './actionRevert'
import type { ActionQueueStatus, TriageAction, TriageResult } from './actions'
import type { AiGenerateRequest, AiSettingKey, AiSettings, AiStreamEvent } from './ai'
import type { AccountSyncStatus, AuthSignInResult, AuthStatus } from './auth'
import type { CommandUsage } from './commandUsage'
import type { ContactSearchResult } from './contacts'
import type { UpdateState } from './distribution'
import type {
  Draft,
  DraftAttachmentMutationResult,
  DraftInlineImageInput,
  DraftInlineImageResult,
  DraftKind,
  DraftSaveInput
} from './drafts'
import type {
  Conversation,
  ConversationMailbox,
  DownloadAttachmentRequest,
  DownloadAttachmentResult,
  InlineImageRepairRequest,
  InlineImageRequest,
  InlineImageResult,
  MailLabel,
  SyncState,
  SystemMailboxCounts,
  ThreadListRequest,
  ThreadPage
} from './mail'
import type { PendingFocusTarget } from './notifications'
import type { OutboxChanged, OutboxItem, QueueSendResult, ReopenOutboxResult } from './outbox'
import type { SearchResponse, ServerSearchResponse } from './searchQuery'
import type { AccountSettingKey, AccountSettings, AppSettingKey, AppSettings } from './settings'
import type { Snippet, SnippetSaveInput } from './snippets'
import type {
  ReorderSplitsInput,
  SaveSplitInput,
  SplitPresetId,
  SplitState,
  SplitThreadLocation
} from './splits'
import type { ThemePreference } from './theme'

export const IPC_CHANNELS = {
  authGetStatus: 'auth:getStatus',
  authSignIn: 'auth:signIn',
  accountsSetActive: 'accounts:setActive',
  accountsGetStatuses: 'accounts:getStatuses',
  accountsRemove: 'accounts:remove',
  accountsReorder: 'accounts:reorder',
  settingsGetTheme: 'settings:getTheme',
  settingsSetTheme: 'settings:setTheme',
  settingsGetAll: 'settings:getAll',
  settingsSet: 'settings:set',
  settingsGetAccount: 'settings:getAccount',
  settingsSetAccount: 'settings:setAccount',
  settingsGetCommandUsage: 'settings:getCommandUsage',
  settingsSetCommandUsage: 'settings:setCommandUsage',
  snippetsList: 'snippets:list',
  snippetsSave: 'snippets:save',
  snippetsDelete: 'snippets:delete',
  aiGetSettings: 'ai:getSettings',
  aiSetSetting: 'ai:setSetting',
  aiSetKey: 'ai:setKey',
  aiDeleteKey: 'ai:deleteKey',
  aiGenerate: 'ai:generate',
  aiCancel: 'ai:cancel',
  aiStyleExamples: 'ai:styleExamples',
  aiStreamEvent: 'ai:streamEvent',
  contactsSearch: 'contacts:search',
  draftSave: 'draft:save',
  draftGet: 'draft:get',
  draftList: 'draft:list',
  draftReopen: 'draft:reopen',
  draftCreateReply: 'draft:createReply',
  draftPickAttachments: 'draft:pickAttachments',
  draftAddAttachments: 'draft:addAttachments',
  draftRemoveAttachment: 'draft:removeAttachment',
  draftAddInlineImage: 'draft:addInlineImage',
  draftGetInlineImage: 'draft:getInlineImage',
  draftClose: 'draft:close',
  draftDiscard: 'draft:discard',
  draftMirror: 'draft:mirror',
  draftTakeRecovered: 'draft:takeRecovered',
  draftCheckpointRequest: 'draft:checkpointRequest',
  draftCheckpointDone: 'draft:checkpointDone',
  outboxSend: 'outbox:send',
  outboxUndoSend: 'outbox:undoSend',
  outboxReopen: 'outbox:reopen',
  outboxListPending: 'outbox:listPending',
  outboxChanged: 'outbox:changed',
  outboxProgress: 'outbox:progress',
  updateGetState: 'update:getState',
  updateRestart: 'update:restart',
  updateState: 'update:state',
  syncGetState: 'sync:getState',
  syncGetInboxReady: 'sync:getInboxReady',
  syncRetry: 'sync:retry',
  mailTakePendingFocus: 'mail:takePendingFocus',
  mailAcknowledgePendingFocus: 'mail:acknowledgePendingFocus',
  mailSearch: 'mail:search',
  mailSearchAll: 'mail:searchAll',
  mailCancelSearchAll: 'mail:cancelSearchAll',
  mailListThreads: 'mail:listThreads',
  mailListLabels: 'mail:listLabels',
  mailGetMailboxCounts: 'mail:getMailboxCounts',
  mailGetUnreadCount: 'mail:getUnreadCount',
  splitsGetState: 'splits:getState',
  splitsGetThreadLocation: 'splits:getThreadLocation',
  splitsSave: 'splits:save',
  splitsSetNotify: 'splits:setNotify',
  splitsDelete: 'splits:delete',
  splitsReorder: 'splits:reorder',
  splitsRestorePreset: 'splits:restorePreset',
  mailPeekActionsReverted: 'mail:peekActionsReverted',
  mailAcknowledgeActionsReverted: 'mail:acknowledgeActionsReverted',
  mailGetConversation: 'mail:getConversation',
  mailDownloadAttachment: 'mail:downloadAttachment',
  mailGetInlineImage: 'mail:getInlineImage',
  mailRepairInlineImages: 'mail:repairInlineImages',
  mailRegisterMessageFrame: 'mail:registerMessageFrame',
  mailUnregisterMessageFrame: 'mail:unregisterMessageFrame',
  mailAllowRemoteImagesOnce: 'mail:allowRemoteImagesOnce',
  mailAllowRemoteImagesFromSender: 'mail:allowRemoteImagesFromSender',
  mailListRemoteImageOverrides: 'mail:listRemoteImageOverrides',
  mailRemoveRemoteImageOverride: 'mail:removeRemoteImageOverride',
  mailTriage: 'mail:triage',
  mailSnooze: 'mail:snooze',
  mailMarkReadOnOpen: 'mail:markReadOnOpen',
  mailUndo: 'mail:undo',
  mailGetPendingActionCount: 'mail:getPendingActionCount',
  mailGetActionQueueStatus: 'mail:getActionQueueStatus',
  mailChanged: 'mail:changed',
  mailRemoteImagesChanged: 'mail:remoteImagesChanged',
  mailActionsReverted: 'mail:actionsReverted',
  mailBodyHydrationFailed: 'mail:bodyHydrationFailed',
  mailFocusThreadAvailable: 'mail:focusThreadAvailable',
  accountsStatusChanged: 'accounts:statusChanged',
  syncState: 'sync:state'
} as const

export type MailChangeReason = 'split-metadata'

/**
 * E2E-only channels, registered by the main process solely under
 * ATTN_TEST_USER_DATA. They live here so main and the specs share one literal
 * and a rename fails at compile time rather than silently at runtime.
 */
export const TEST_CHANNELS = {
  focusThread: 'attn:test:focusThread',
  setSyncState: 'attn:test:setSyncState',
  reloadSeed: 'attn:test:reloadSeed',
  deleteThread: 'attn:test:deleteThread',
  delayConversation: 'attn:test:delayConversation',
  delayDraftReopen: 'attn:test:delayDraftReopen',
  delayDraftInlineImage: 'attn:test:delayDraftInlineImage',
  updateMessageBody: 'attn:test:updateMessageBody',
  setSendAsSignature: 'attn:test:setSendAsSignature',
  failNextDraftSave: 'attn:test:failNextDraftSave',
  markDraftMirrored: 'attn:test:markDraftMirrored',
  failNextAction: 'attn:test:failNextAction',
  failNextActionAuth: 'attn:test:failNextActionAuth',
  delaySetActiveAccount: 'attn:test:delaySetActiveAccount',
  setAttachmentPickerFiles: 'attn:test:setAttachmentPickerFiles',
  setUndoSendDelay: 'attn:test:setUndoSendDelay',
  failOutbox: 'attn:test:failOutbox',
  remoteDraft: 'attn:test:remoteDraft',
  installSendProvider: 'attn:test:installSendProvider',
  runHistoryCycle: 'attn:test:runHistoryCycle',
  installFakeAiProvider: 'attn:test:installFakeAiProvider',
  aiProviderRequests: 'attn:test:aiProviderRequests',
  runLifetimeSweep: 'attn:test:runLifetimeSweep',
  runExistenceSweep: 'attn:test:runExistenceSweep',
  runFtsBackfill: 'attn:test:runFtsBackfill',
  searchIndexStats: 'attn:test:searchIndexStats',
  queryPerfStats: 'attn:test:queryPerfStats',
  setSearchWindow: 'attn:test:setSearchWindow',
  utilityState: 'attn:test:utilityState',
  crashUtility: 'attn:test:crashUtility',
  accountDataStats: 'attn:test:accountDataStats',
  listMailboxThreadIds: 'attn:test:listMailboxThreadIds',
  setUpdateState: 'attn:test:setUpdateState',
  holdNextResponse: 'attn:test:holdNextResponse',
  expireReminders: 'attn:test:expireReminders',
  observeInvokes: 'attn:test:observeInvokes',
  invokeHandler: 'attn:test:invokeHandler',
  failNextInvoke: 'attn:test:failNextInvoke'
} as const

export interface InvokeChannels {
  [IPC_CHANNELS.authGetStatus]: { args: []; result: AuthStatus }
  [IPC_CHANNELS.authSignIn]: { args: []; result: AuthSignInResult }
  [IPC_CHANNELS.accountsSetActive]: { args: [accountId: string]; result: AuthStatus }
  [IPC_CHANNELS.accountsGetStatuses]: { args: []; result: AccountSyncStatus[] }
  [IPC_CHANNELS.accountsRemove]: { args: [accountId: string, deleteData: boolean]; result: AuthStatus }
  [IPC_CHANNELS.accountsReorder]: { args: [accountIds: string[]]; result: AuthStatus }
  [IPC_CHANNELS.settingsGetTheme]: { args: []; result: ThemePreference }
  [IPC_CHANNELS.settingsSetTheme]: { args: [preference: ThemePreference]; result: ThemePreference }
  [IPC_CHANNELS.settingsGetAll]: { args: []; result: AppSettings }
  [IPC_CHANNELS.settingsSet]: {
    args: [key: AppSettingKey, value: AppSettings[AppSettingKey]]
    result: AppSettings
  }
  [IPC_CHANNELS.settingsGetAccount]: { args: [accountId: string]; result: AccountSettings }
  [IPC_CHANNELS.settingsSetAccount]: {
    args: [accountId: string, key: AccountSettingKey, value: AccountSettings[AccountSettingKey]]
    result: AccountSettings
  }
  [IPC_CHANNELS.settingsGetCommandUsage]: { args: [accountId: string]; result: CommandUsage }
  [IPC_CHANNELS.settingsSetCommandUsage]: {
    args: [accountId: string, usage: CommandUsage]
    result: CommandUsage
  }
  // F8 snippets are app-global: no account id rides these calls, and each
  // mutation returns the fresh list so callers never hold a stale catalog.
  [IPC_CHANNELS.snippetsList]: { args: []; result: Snippet[] }
  [IPC_CHANNELS.snippetsSave]: { args: [input: SnippetSaveInput]; result: Snippet[] }
  [IPC_CHANNELS.snippetsDelete]: { args: [id: string]; result: Snippet[] }
  // T36 AI writing: settings storage rides the utility (keyPresent is main's
  // to fill in); key custody and generation never leave the main process.
  [IPC_CHANNELS.aiGetSettings]: { args: []; result: AiSettings }
  [IPC_CHANNELS.aiSetSetting]: {
    args: [key: AiSettingKey, value: AiSettings[AiSettingKey]]
    result: AiSettings
  }
  [IPC_CHANNELS.aiSetKey]: { args: [key: string]; result: AiSettings }
  [IPC_CHANNELS.aiDeleteKey]: { args: []; result: AiSettings }
  [IPC_CHANNELS.aiGenerate]: { args: [request: AiGenerateRequest]; result: { requestId: string } }
  [IPC_CHANNELS.aiCancel]: { args: [requestId: string]; result: undefined }
  // T37 voice matching: the active account's recent sent replies, selected
  // locally in the utility; the renderer attaches them only when the voice
  // toggle is on, and the transport strips them again when it is off.
  [IPC_CHANNELS.aiStyleExamples]: { args: [excludeThreadId: string]; result: string[] }
  [IPC_CHANNELS.contactsSearch]: { args: [query: string]; result: ContactSearchResult[] }
  [IPC_CHANNELS.draftSave]: {
    args: [draft: DraftSaveInput]
    result: { id: string; draft: Draft | null }
  }
  [IPC_CHANNELS.draftGet]: { args: [id: string]; result: Draft | null }
  [IPC_CHANNELS.draftList]: { args: []; result: Draft[] }
  [IPC_CHANNELS.draftReopen]: { args: [id: string]; result: Draft | null }
  [IPC_CHANNELS.draftCreateReply]: {
    args: [
      threadId: string,
      kind: Exclude<DraftKind, 'new'>,
      mailbox: ConversationMailbox,
      sourceMessageId?: string
    ]
    result: Draft | null
  }
  [IPC_CHANNELS.draftPickAttachments]: {
    args: [id: string]
    result: DraftAttachmentMutationResult
  }
  [IPC_CHANNELS.draftAddAttachments]: {
    args: [id: string, paths: string[]]
    result: DraftAttachmentMutationResult
  }
  [IPC_CHANNELS.draftRemoveAttachment]: {
    args: [id: string, attachmentId: string]
    result: DraftAttachmentMutationResult
  }
  [IPC_CHANNELS.draftAddInlineImage]: {
    args: [id: string, image: DraftInlineImageInput]
    result: DraftInlineImageResult
  }
  [IPC_CHANNELS.draftGetInlineImage]: {
    args: [id: string, contentId: string]
    result: InlineImageResult
  }
  [IPC_CHANNELS.draftClose]: { args: [id: string]; result: 'saved' | 'discarded' }
  [IPC_CHANNELS.draftDiscard]: {
    args: [id: string, expectedState?: 'composing' | 'drafted']
    result: undefined
  }
  [IPC_CHANNELS.draftMirror]: { args: [id: string]; result: undefined }
  [IPC_CHANNELS.draftTakeRecovered]: { args: []; result: Draft | null }
  [IPC_CHANNELS.outboxSend]: { args: [draftId: string]; result: QueueSendResult }
  [IPC_CHANNELS.outboxUndoSend]: { args: [outboxId: string]; result: ReopenOutboxResult }
  [IPC_CHANNELS.outboxReopen]: { args: [outboxId: string]; result: ReopenOutboxResult }
  [IPC_CHANNELS.outboxListPending]: { args: []; result: OutboxItem[] }
  // T39 auto-update: main-owned; a personal, dev, or seeded build answers
  // idle and restart resolves false — there is no updater to talk to.
  [IPC_CHANNELS.updateGetState]: { args: []; result: UpdateState }
  [IPC_CHANNELS.updateRestart]: { args: []; result: boolean }
  [IPC_CHANNELS.syncGetState]: { args: []; result: SyncState }
  [IPC_CHANNELS.syncGetInboxReady]: { args: []; result: boolean }
  [IPC_CHANNELS.syncRetry]: { args: []; result: undefined }
  [IPC_CHANNELS.mailTakePendingFocus]: { args: []; result: PendingFocusTarget | null }
  [IPC_CHANNELS.mailAcknowledgePendingFocus]: { args: [id: number]; result: undefined }
  [IPC_CHANNELS.mailSearch]: { args: [query: string]; result: SearchResponse }
  [IPC_CHANNELS.mailSearchAll]: {
    args: [requestId: string, query: string]
    result: ServerSearchResponse
  }
  [IPC_CHANNELS.mailCancelSearchAll]: { args: [requestId: string]; result: undefined }
  // Snoozed rows carry their reminder fields: the result is SnoozedThreadRow[]
  // when view is 'snoozed', which the preload narrows for the renderer.
  [IPC_CHANNELS.mailListThreads]: { args: [request: ThreadListRequest]; result: ThreadPage }
  [IPC_CHANNELS.mailListLabels]: { args: []; result: MailLabel[] }
  [IPC_CHANNELS.mailGetMailboxCounts]: { args: []; result: SystemMailboxCounts }
  [IPC_CHANNELS.mailGetUnreadCount]: { args: []; result: number }
  [IPC_CHANNELS.splitsGetState]: { args: []; result: SplitState }
  [IPC_CHANNELS.splitsGetThreadLocation]: {
    args: [threadId: string]
    result: SplitThreadLocation | null
  }
  [IPC_CHANNELS.splitsSave]: { args: [input: SaveSplitInput]; result: SplitState }
  [IPC_CHANNELS.splitsSetNotify]: {
    args: [id: string, notify: boolean]
    result: SplitState
  }
  [IPC_CHANNELS.splitsDelete]: { args: [id: string]; result: SplitState }
  [IPC_CHANNELS.splitsReorder]: { args: [input: ReorderSplitsInput]; result: SplitState }
  [IPC_CHANNELS.splitsRestorePreset]: { args: [id: SplitPresetId]; result: SplitState }
  [IPC_CHANNELS.mailPeekActionsReverted]: {
    args: [accountId: string]
    result: ActionRevertNotice | null
  }
  [IPC_CHANNELS.mailAcknowledgeActionsReverted]: {
    args: [accountId: string, noticeId: number]
    result: boolean
  }
  [IPC_CHANNELS.mailGetConversation]: {
    args: [threadId: string, allowHydration: boolean, mailbox: ConversationMailbox]
    result: Conversation | null
  }
  [IPC_CHANNELS.mailDownloadAttachment]: {
    args: [request: DownloadAttachmentRequest]
    result: DownloadAttachmentResult
  }
  [IPC_CHANNELS.mailGetInlineImage]: { args: [request: InlineImageRequest]; result: InlineImageResult }
  [IPC_CHANNELS.mailRepairInlineImages]: {
    args: [request: InlineImageRepairRequest]
    result: boolean
  }
  // T33 remote images: the reader registers each mounted mail frame under the
  // nonce it set as the iframe's name; main answers whether that message's
  // images load so the banner needs no second policy source. Registration
  // carries no allowance of its own — a `Load once` render is admitted only
  // by the grant the gesture channel below minted in main for that nonce.
  [IPC_CHANNELS.mailRegisterMessageFrame]: {
    args: [nonce: string, messageId: string]
    result: { blocked: boolean; imagesAllowed: boolean }
  }
  [IPC_CHANNELS.mailUnregisterMessageFrame]: { args: [nonce: string]; result: undefined }
  /** The reader's `Load once` gesture: main records the one-shot grant. */
  [IPC_CHANNELS.mailAllowRemoteImagesOnce]: {
    args: [nonce: string, messageId: string]
    result: undefined
  }
  [IPC_CHANNELS.mailAllowRemoteImagesFromSender]: {
    args: [messageId: string]
    result: { sender: string; overrides: string[] }
  }
  [IPC_CHANNELS.mailListRemoteImageOverrides]: { args: []; result: string[] }
  [IPC_CHANNELS.mailRemoveRemoteImageOverride]: { args: [address: string]; result: string[] }
  [IPC_CHANNELS.mailTriage]: { args: [action: TriageAction]; result: TriageResult }
  [IPC_CHANNELS.mailSnooze]: {
    args: [input: { threadIds: string[]; dueAt: number }]
    result: TriageResult
  }
  [IPC_CHANNELS.mailMarkReadOnOpen]: { args: [threadId: string]; result: undefined }
  [IPC_CHANNELS.mailUndo]: { args: []; result: TriageResult | null }
  [IPC_CHANNELS.mailGetPendingActionCount]: { args: []; result: number }
  [IPC_CHANNELS.mailGetActionQueueStatus]: { args: []; result: ActionQueueStatus }
  /**
   * The renderer's answer to a checkpoint request (B28): the open composer
   * committed, or there was none. Main waits on it before tearing down, so a
   * quit cannot drop the last second of typing.
   */
  [IPC_CHANNELS.draftCheckpointDone]: { args: [requestId: number]; result: undefined }
}

export interface BroadcastChannels {
  [IPC_CHANNELS.outboxChanged]: OutboxChanged
  [IPC_CHANNELS.outboxProgress]: import('./outbox').OutboxProgress | null
  [IPC_CHANNELS.mailChanged]: { serverSearchRequestId?: string; reason?: MailChangeReason }
  // T33: the stored remote-image policy moved (toggle or per-sender override);
  // mounted mail frames re-register to pick up their fresh answers.
  [IPC_CHANNELS.mailRemoteImagesChanged]: undefined
  [IPC_CHANNELS.aiStreamEvent]: AiStreamEvent
  [IPC_CHANNELS.mailActionsReverted]: undefined
  [IPC_CHANNELS.mailBodyHydrationFailed]: { accountId: string; threadId: string }
  [IPC_CHANNELS.mailFocusThreadAvailable]: undefined
  // B28: quit is imminent — commit any open composer while the document is
  // still alive, then answer on `draft:checkpointDone` with this id.
  [IPC_CHANNELS.draftCheckpointRequest]: { requestId: number }
  [IPC_CHANNELS.accountsStatusChanged]: AccountSyncStatus[]
  [IPC_CHANNELS.updateState]: UpdateState
  [IPC_CHANNELS.syncState]: SyncState
}

export type InvokeChannel = keyof InvokeChannels
export type BroadcastChannel = keyof BroadcastChannels

const BROADCAST_CHANNELS = {
  [IPC_CHANNELS.outboxChanged]: true,
  [IPC_CHANNELS.outboxProgress]: true,
  [IPC_CHANNELS.mailChanged]: true,
  [IPC_CHANNELS.mailRemoteImagesChanged]: true,
  [IPC_CHANNELS.aiStreamEvent]: true,
  [IPC_CHANNELS.mailActionsReverted]: true,
  [IPC_CHANNELS.mailBodyHydrationFailed]: true,
  [IPC_CHANNELS.mailFocusThreadAvailable]: true,
  [IPC_CHANNELS.draftCheckpointRequest]: true,
  [IPC_CHANNELS.accountsStatusChanged]: true,
  [IPC_CHANNELS.updateState]: true,
  [IPC_CHANNELS.syncState]: true
} satisfies Record<BroadcastChannel, true>

function isBroadcastChannel(channel: string): channel is BroadcastChannel {
  return channel in BROADCAST_CHANNELS
}

export const INVOKE_CHANNEL_NAMES = Object.values(IPC_CHANNELS).filter(
  (channel): channel is InvokeChannel => !isBroadcastChannel(channel)
)
