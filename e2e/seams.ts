import type { ElectronApplication, Page } from '@playwright/test'
import type { GmailThread } from '../src/main/gmail/parse'
import { TEST_CHANNELS } from '../src/shared/ipc'
import type { MessageMailbox, SyncState } from '../src/shared/mail'
import { expect } from './electron'

// The one place that knows how a `attn:test:` seam is called from a spec
// (R14). Every seam is an `ipcMain.emit(channel, {}, ...args, done)` on the
// main process; the three shapes below differ only in what `done` reports, so
// specs describe the seam they want instead of re-deriving the emit.

/**
 * Emit a seam whose completion callback carries a result, and resolve with it.
 * The callback is appended after `args`, exactly where each seam's handler in
 * `src/main/testIpc.ts` looks for it.
 */
export function callSeam<T>(app: ElectronApplication, channel: string, ...args: unknown[]): Promise<T> {
  return app.evaluate(
    ({ ipcMain }, input) =>
      new Promise((resolve) => ipcMain.emit(input.channel, {}, ...input.args, resolve)) as Promise<T>,
    { channel, args }
  )
}

/** Emit a seam whose completion callback reports only an optional error string. */
export async function emitSeam(app: ElectronApplication, channel: string, ...args: unknown[]): Promise<void> {
  const error = await callSeam<string | undefined>(app, channel, ...args)
  if (error) throw new Error(error)
}

/** Emit a seam that takes no completion callback (fire and forget). */
export function fireSeam(app: ElectronApplication, channel: string, ...args: unknown[]): Promise<void> {
  return app.evaluate(
    ({ ipcMain }, input) => {
      ipcMain.emit(input.channel, {}, ...input.args)
    },
    { channel, args }
  )
}

/** One request recorded by the fake AI provider — the privacy proof for F17. */
export interface RecordedAiRequest {
  purpose: string
  system: string
  messages: Array<{ role: string; content: string }>
  canceled: boolean
}

/** Install the scripted fake AI provider (T36); the only endpoint in the suite. */
export function installFakeAi(app: ElectronApplication, script?: unknown): Promise<void> {
  return emitSeam(app, TEST_CHANNELS.installFakeAiProvider, script)
}

/** Everything the fake provider has been asked for so far, cancellations included. */
export function aiRequests(app: ElectronApplication): Promise<RecordedAiRequest[]> {
  return callSeam<RecordedAiRequest[]>(app, TEST_CHANNELS.aiProviderRequests)
}

/** Send immediately through the fake send provider: no undo window, no Gmail. */
export async function armSending(app: ElectronApplication): Promise<void> {
  await fireSeam(app, TEST_CHANNELS.setUndoSendDelay, 0)
  await emitSeam(app, TEST_CHANNELS.installSendProvider, undefined)
}

/** Publish a sync state the way the sync engine would (F13 banners). */
export function setSyncState(app: ElectronApplication, state: SyncState): Promise<void> {
  return fireSeam(app, TEST_CHANNELS.setSyncState, state)
}

/** Model a notification click on a thread (F12). */
export function emitFocusThread(app: ElectronApplication, threadId: string): Promise<void> {
  return fireSeam(app, TEST_CHANNELS.focusThread, threadId)
}

/** Production per-message mailbox membership, read straight from the store. */
export function mailboxThreadIds(app: ElectronApplication, mailbox: MessageMailbox): Promise<string[]> {
  return app.evaluate(
    ({ ipcMain }, input) =>
      new Promise<string[]>((resolve, reject) => {
        ipcMain.emit(input.channel, {}, input.mailbox, (threadIds: string[], error?: string) =>
          error ? reject(new Error(error)) : resolve(threadIds)
        )
      }),
    { channel: TEST_CHANNELS.listMailboxThreadIds, mailbox }
  )
}

/**
 * A header-only Gmail thread from outside the lifetime window — the fixture
 * the sweep specs feed to the seam's in-memory provider.
 */
export function oldThread(
  id: string,
  recipient: string,
  year: number,
  labelIds: string[] = ['SENT']
): GmailThread {
  return {
    id,
    messages: [
      {
        id: `message-${id}`,
        threadId: id,
        labelIds,
        internalDate: String(Date.UTC(year, 0, 2)),
        snippet: `A header-only note to ${recipient}`,
        payload: {
          mimeType: 'multipart/mixed',
          headers: [
            { name: 'From', value: 'Attn Seed <seed@attn.test>' },
            { name: 'To', value: recipient },
            { name: 'Subject', value: `Old correspondence from ${year}` },
            { name: 'Message-ID', value: `<${id}@attn.test>` }
          ]
        }
      }
    ]
  }
}

export interface LifetimeSweepRequest {
  resetCursor?: string
  threadCap?: number
  threads: GmailThread[]
  pages: Array<{
    pageToken?: string
    threadIds: string[]
    nextPageToken?: string
    resultSizeEstimate?: number
  }>
  offlineAtPageToken?: string
  pauseAtPageToken?: string
  threadsTotal?: number
  messagesTotal?: number
}

export interface LifetimeSweepResult {
  cursor: string | null
  error?: string
  formats: string[]
  pageTokens: Array<string | undefined>
}

/** Run the production lifetime worker against an in-memory provider. */
export function runSweep(
  app: ElectronApplication,
  request: LifetimeSweepRequest
): Promise<LifetimeSweepResult> {
  return callSeam<LifetimeSweepResult>(app, TEST_CHANNELS.runLifetimeSweep, request)
}

export interface ExistenceSweepRequest {
  allMailThreadIds: string[]
  spamThreadIds: string[]
  trashThreadIds: string[]
}

export interface ExistenceSweepResult {
  listedThreadCount: number
  deletedThreadIds: string[]
  error?: string
}

/** Run the production expiry tombstone pass against complete listings. */
export function runExistenceSweep(
  app: ElectronApplication,
  request: ExistenceSweepRequest
): Promise<ExistenceSweepResult> {
  return callSeam<ExistenceSweepResult>(app, TEST_CHANNELS.runExistenceSweep, request)
}

/**
 * Hold one real IPC result after main has finished computing it, without a
 * timing-based sleep. The returned function releases the held response, so a
 * spec can interleave a competing action deterministically between the
 * handler's work and its delivery to the renderer.
 */
export async function holdNextResponse(
  app: ElectronApplication,
  channel: string
): Promise<() => Promise<void>> {
  await callSeam<boolean>(app, TEST_CHANNELS.holdNextResponse, { action: 'arm', channel })
  return async () => {
    await callSeam<boolean>(app, TEST_CHANNELS.holdNextResponse, { action: 'release' })
  }
}

/** Poll until the held handler has finished its work and parked the response. */
export async function expectResponseHeld(app: ElectronApplication): Promise<void> {
  await expect
    .poll(() => callSeam<boolean>(app, TEST_CHANNELS.holdNextResponse, { action: 'status' }))
    .toBe(true)
}

/**
 * Settle the renderer's IPC queue: two real round trips through the bridge.
 * A response released above is delivered before these, and anything its
 * continuation invokes is answered before the second — so once this resolves,
 * work that was going to happen has happened. It is the deterministic
 * replacement for "give it a beat" before a negative assertion (T3).
 */
export async function flushRendererIpc(page: Page): Promise<void> {
  await page.evaluate(() => window.attn.settings.getAll())
  await page.evaluate(() => window.attn.settings.getAll())
}
