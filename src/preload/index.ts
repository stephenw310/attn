import { contextBridge, ipcRenderer } from 'electron'
import type { TriageAction, TriageResult } from '../shared/actions'
import type { AuthStatus } from '../shared/auth'
import type { ContactSearchResult } from '../shared/contacts'
import type {
  Draft,
  DraftInlineImageInput,
  DraftInlineImageResult,
  DraftKind,
  DraftSaveInput
} from '../shared/drafts'
import { type InvokeChannel, type InvokeChannels, IPC_CHANNELS } from '../shared/ipc'
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
} from '../shared/mail'

function invoke<K extends InvokeChannel>(
  channel: K,
  ...args: InvokeChannels[K]['args']
): Promise<InvokeChannels[K]['result']> {
  return ipcRenderer.invoke(channel, ...args)
}

const api = {
  platform: process.platform,
  auth: {
    getStatus: (): Promise<AuthStatus> => invoke(IPC_CHANNELS.authGetStatus),
    signIn: (): Promise<AuthStatus> => invoke(IPC_CHANNELS.authSignIn),
    signOut: (): Promise<AuthStatus> => invoke(IPC_CHANNELS.authSignOut)
  },
  mail: {
    listThreads: (): Promise<ThreadRow[]> => invoke(IPC_CHANNELS.mailListThreads),
    listSnoozed: (): Promise<SnoozedThreadRow[]> => invoke(IPC_CHANNELS.mailListSnoozed),
    listLabels: (): Promise<MailLabel[]> => invoke(IPC_CHANNELS.mailListLabels),
    getUnreadCount: (): Promise<number> => invoke(IPC_CHANNELS.mailGetUnreadCount),
    getConversation: (threadId: string, allowHydration: boolean): Promise<Conversation | null> =>
      invoke(IPC_CHANNELS.mailGetConversation, threadId, allowHydration),
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
    onChanged: (cb: () => void): (() => void) => {
      const listener = (): void => cb()
      ipcRenderer.on(IPC_CHANNELS.mailChanged, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.mailChanged, listener)
    },
    onBodyHydrationFailed: (cb: (accountId: string, threadId: string) => void): (() => void) => {
      const listener = (_event: unknown, payload: { accountId: string; threadId: string }): void =>
        cb(payload.accountId, payload.threadId)
      ipcRenderer.on(IPC_CHANNELS.mailBodyHydrationFailed, listener)
      return () => ipcRenderer.removeListener(IPC_CHANNELS.mailBodyHydrationFailed, listener)
    },
    onFocusThread: (cb: (threadId: string) => void): (() => void) => {
      let active = true
      const takePendingFocus = async (): Promise<void> => {
        const threadId = await invoke(IPC_CHANNELS.mailTakePendingFocus)
        if (active && typeof threadId === 'string' && threadId.length > 0) cb(threadId)
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
  contacts: {
    search: (query: string): Promise<ContactSearchResult[]> => invoke(IPC_CHANNELS.contactsSearch, query)
  },
  draft: {
    save: (draft: DraftSaveInput): Promise<{ id: string; draft: Draft | null }> =>
      invoke(IPC_CHANNELS.draftSave, draft),
    get: (id: string): Promise<Draft | null> => invoke(IPC_CHANNELS.draftGet, id),
    list: (): Promise<Draft[]> => invoke(IPC_CHANNELS.draftList),
    reopen: (id: string): Promise<Draft | null> => invoke(IPC_CHANNELS.draftReopen, id),
    createReply: (threadId: string, kind: Exclude<DraftKind, 'new'>): Promise<Draft | null> =>
      invoke(IPC_CHANNELS.draftCreateReply, threadId, kind),
    addInlineImage: (id: string, image: DraftInlineImageInput): Promise<DraftInlineImageResult> =>
      invoke(IPC_CHANNELS.draftAddInlineImage, id, image),
    getInlineImage: (id: string, contentId: string): Promise<InlineImageResult> =>
      invoke(IPC_CHANNELS.draftGetInlineImage, id, contentId),
    close: (id: string): Promise<'saved' | 'discarded'> => invoke(IPC_CHANNELS.draftClose, id),
    discard: (id: string): Promise<void> => invoke(IPC_CHANNELS.draftDiscard, id),
    mirror: (id: string): Promise<void> => invoke(IPC_CHANNELS.draftMirror, id),
    takeRecovered: (): Promise<Draft | null> => invoke(IPC_CHANNELS.draftTakeRecovered)
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
