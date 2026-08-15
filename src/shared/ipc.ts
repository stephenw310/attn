import type { TriageAction, TriageResult } from './actions'
import type { AuthStatus } from './auth'
import type { ContactSearchResult } from './contacts'
import type {
  Draft,
  DraftInlineImageInput,
  DraftInlineImageResult,
  DraftKind,
  DraftSaveInput
} from './drafts'
import type {
  Conversation,
  DownloadAttachmentRequest,
  DownloadAttachmentResult,
  InlineImageRepairRequest,
  InlineImageRequest,
  InlineImageResult,
  MailLabel,
  SnoozedThreadRow,
  SyncState,
  ThreadRow
} from './mail'

export const IPC_CHANNELS = {
  authGetStatus: 'auth:getStatus',
  authSignIn: 'auth:signIn',
  authSignOut: 'auth:signOut',
  contactsSearch: 'contacts:search',
  draftSave: 'draft:save',
  draftGet: 'draft:get',
  draftList: 'draft:list',
  draftReopen: 'draft:reopen',
  draftCreateReply: 'draft:createReply',
  draftAddInlineImage: 'draft:addInlineImage',
  draftGetInlineImage: 'draft:getInlineImage',
  draftClose: 'draft:close',
  draftDiscard: 'draft:discard',
  draftMirror: 'draft:mirror',
  draftTakeRecovered: 'draft:takeRecovered',
  syncGetState: 'sync:getState',
  syncRetry: 'sync:retry',
  mailTakePendingFocus: 'mail:takePendingFocus',
  mailListThreads: 'mail:listThreads',
  mailListSnoozed: 'mail:listSnoozed',
  mailListLabels: 'mail:listLabels',
  mailGetUnreadCount: 'mail:getUnreadCount',
  mailGetConversation: 'mail:getConversation',
  mailDownloadAttachment: 'mail:downloadAttachment',
  mailGetInlineImage: 'mail:getInlineImage',
  mailRepairInlineImages: 'mail:repairInlineImages',
  mailTriage: 'mail:triage',
  mailSnooze: 'mail:snooze',
  mailMarkReadOnOpen: 'mail:markReadOnOpen',
  mailUndo: 'mail:undo',
  mailGetPendingActionCount: 'mail:getPendingActionCount',
  mailChanged: 'mail:changed',
  mailBodyHydrationFailed: 'mail:bodyHydrationFailed',
  mailFocusThreadAvailable: 'mail:focusThreadAvailable',
  syncState: 'sync:state'
} as const

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
  delayDraftInlineImage: 'attn:test:delayDraftInlineImage',
  updateMessageBody: 'attn:test:updateMessageBody',
  failNextDraftSave: 'attn:test:failNextDraftSave',
  markDraftMirrored: 'attn:test:markDraftMirrored',
  remoteDraft: 'attn:test:remoteDraft'
} as const

export type TestChannel = (typeof TEST_CHANNELS)[keyof typeof TEST_CHANNELS]

export interface InvokeChannels {
  [IPC_CHANNELS.authGetStatus]: { args: []; result: AuthStatus }
  [IPC_CHANNELS.authSignIn]: { args: []; result: AuthStatus }
  [IPC_CHANNELS.authSignOut]: { args: []; result: AuthStatus }
  [IPC_CHANNELS.contactsSearch]: { args: [query: string]; result: ContactSearchResult[] }
  [IPC_CHANNELS.draftSave]: { args: [draft: DraftSaveInput]; result: { id: string } }
  [IPC_CHANNELS.draftGet]: { args: [id: string]; result: Draft | null }
  [IPC_CHANNELS.draftList]: { args: []; result: Draft[] }
  [IPC_CHANNELS.draftReopen]: { args: [id: string]; result: Draft | null }
  [IPC_CHANNELS.draftCreateReply]: {
    args: [threadId: string, kind: Exclude<DraftKind, 'new'>]
    result: Draft | null
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
  [IPC_CHANNELS.draftDiscard]: { args: [id: string]; result: undefined }
  [IPC_CHANNELS.draftMirror]: { args: [id: string]; result: undefined }
  [IPC_CHANNELS.draftTakeRecovered]: { args: []; result: Draft | null }
  [IPC_CHANNELS.syncGetState]: { args: []; result: SyncState }
  [IPC_CHANNELS.syncRetry]: { args: []; result: undefined }
  [IPC_CHANNELS.mailTakePendingFocus]: { args: []; result: string | null }
  [IPC_CHANNELS.mailListThreads]: { args: []; result: ThreadRow[] }
  [IPC_CHANNELS.mailListSnoozed]: { args: []; result: SnoozedThreadRow[] }
  [IPC_CHANNELS.mailListLabels]: { args: []; result: MailLabel[] }
  [IPC_CHANNELS.mailGetUnreadCount]: { args: []; result: number }
  [IPC_CHANNELS.mailGetConversation]: {
    args: [threadId: string, allowHydration: boolean]
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
  [IPC_CHANNELS.mailTriage]: { args: [action: TriageAction]; result: TriageResult }
  [IPC_CHANNELS.mailSnooze]: {
    args: [input: { threadIds: string[]; dueAt: number }]
    result: TriageResult
  }
  [IPC_CHANNELS.mailMarkReadOnOpen]: { args: [threadId: string]; result: undefined }
  [IPC_CHANNELS.mailUndo]: { args: []; result: TriageResult | null }
  [IPC_CHANNELS.mailGetPendingActionCount]: { args: []; result: number }
}

export interface BroadcastChannels {
  [IPC_CHANNELS.mailChanged]: undefined
  [IPC_CHANNELS.mailBodyHydrationFailed]: { accountId: string; threadId: string }
  [IPC_CHANNELS.mailFocusThreadAvailable]: undefined
  [IPC_CHANNELS.syncState]: SyncState
}

export type InvokeChannel = keyof InvokeChannels
export type BroadcastChannel = keyof BroadcastChannels
