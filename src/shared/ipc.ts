import type { TriageAction, TriageResult } from './actions'
import type { AuthStatus } from './auth'
import type {
  Conversation,
  DownloadAttachmentRequest,
  DownloadAttachmentResult,
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
  mailTriage: 'mail:triage',
  mailSnooze: 'mail:snooze',
  mailMarkReadOnOpen: 'mail:markReadOnOpen',
  mailUndo: 'mail:undo',
  mailGetPendingActionCount: 'mail:getPendingActionCount',
  mailChanged: 'mail:changed',
  mailFocusThreadAvailable: 'mail:focusThreadAvailable',
  syncState: 'sync:state'
} as const

export interface InvokeChannels {
  [IPC_CHANNELS.authGetStatus]: { args: []; result: AuthStatus }
  [IPC_CHANNELS.authSignIn]: { args: []; result: AuthStatus }
  [IPC_CHANNELS.authSignOut]: { args: []; result: AuthStatus }
  [IPC_CHANNELS.syncGetState]: { args: []; result: SyncState }
  [IPC_CHANNELS.syncRetry]: { args: []; result: undefined }
  [IPC_CHANNELS.mailTakePendingFocus]: { args: []; result: string | null }
  [IPC_CHANNELS.mailListThreads]: { args: []; result: ThreadRow[] }
  [IPC_CHANNELS.mailListSnoozed]: { args: []; result: SnoozedThreadRow[] }
  [IPC_CHANNELS.mailListLabels]: { args: []; result: MailLabel[] }
  [IPC_CHANNELS.mailGetUnreadCount]: { args: []; result: number }
  [IPC_CHANNELS.mailGetConversation]: { args: [threadId: string]; result: Conversation | null }
  [IPC_CHANNELS.mailDownloadAttachment]: {
    args: [request: DownloadAttachmentRequest]
    result: DownloadAttachmentResult
  }
  [IPC_CHANNELS.mailGetInlineImage]: { args: [request: InlineImageRequest]; result: InlineImageResult }
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
  [IPC_CHANNELS.mailFocusThreadAvailable]: undefined
  [IPC_CHANNELS.syncState]: SyncState
}

export type InvokeChannel = keyof InvokeChannels
export type BroadcastChannel = keyof BroadcastChannels
