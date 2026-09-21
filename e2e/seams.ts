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

/**
 * One smart-splits request as it left the utility — the privacy proof for F17.
 * A request carries a pack of conversations, so `state.threads` is the whole
 * envelope and each entry is one conversation's disclosed state.
 */
export interface RecordedTriageRequest {
  state: { threads: Record<string, unknown>[] }
  questions: Record<string, { instructions?: string; criteria?: unknown }>
}

/**
 * Arm the scripted TypeSafe service. The utility owns one from startup, so the
 * suite cannot reach the real endpoint whether or not a spec calls this.
 */
export function installFakeTriage(app: ElectronApplication, script?: unknown): Promise<void> {
  return emitSeam(app, TEST_CHANNELS.installFakeTriageProvider, script)
}

/**
 * Everything the scripted service has been asked so far, bodies included. The
 * explicit `undefined` holds the request slot these forwarded seams read, so
 * the completion callback lands where `testIpc.ts` looks for it.
 */
export function triageRequests(app: ElectronApplication): Promise<RecordedTriageRequest[]> {
  return callSeam<RecordedTriageRequest[]>(app, TEST_CHANNELS.triageRequests, undefined)
}

/** Run the classifier to quiescence, so a spec asserts on a finished queue. */
export function runTriagePass(app: ElectronApplication): Promise<void> {
  return emitSeam(app, TEST_CHANNELS.runTriagePass, undefined)
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

/** Model the OS handing Attn a `mailto:` link (F16). */
export function openMailto(app: ElectronApplication, url: string): Promise<void> {
  return emitSeam(app, TEST_CHANNELS.openMailto, url)
}

/**
 * Stand in for the OS `mailto:` registration. The suite must never change a
 * developer's default mail app, so the real registration reports itself
 * unsupported under the seam; `null` restores that.
 */
export function setDefaultMailClient(
  app: ElectronApplication,
  state: { supported: boolean; isDefault: boolean } | null
): Promise<void> {
  return emitSeam(app, TEST_CHANNELS.setDefaultMailClient, state)
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
 * Back-date every pending reminder (snooze and follow-up) so the next launch
 * finds it due, once exactly `pending` of them exist — the count is returned,
 * so a spec polls this until the reminder it is waiting on has been written
 * rather than sleeping. The live scheduler is deliberately not refreshed: the
 * deadline must pass while the app is down, which is what the production
 * snooze bridge (which does refresh) cannot express.
 */
export async function expireReminders(app: ElectronApplication, pending: number): Promise<number> {
  const result = await callSeam<number | { error: string }>(app, TEST_CHANNELS.expireReminders, pending)
  if (typeof result !== 'number') throw new Error(result.error)
  return result
}

/**
 * Record the arguments of every invoke on `channel` from now on. The returned
 * reader answers with the calls so far, so a spec can assert what the renderer
 * asked main for — or that it asked nothing — without swapping handlers
 * through Electron's private `_invokeHandlers` map (R14).
 */
export async function observeInvokes(
  app: ElectronApplication,
  channel: string
): Promise<() => Promise<unknown[][]>> {
  await callSeam<unknown[][]>(app, TEST_CHANNELS.observeInvokes, { action: 'watch', channel })
  return () => callSeam<unknown[][]>(app, TEST_CHANNELS.observeInvokes, { action: 'read', channel })
}

/**
 * Call a channel's registered handler inside main, the way a request whose
 * result no renderer subscription is waiting for arrives: main does the work
 * and the answer goes nowhere.
 */
export async function invokeInMain<T>(
  app: ElectronApplication,
  channel: string,
  ...args: unknown[]
): Promise<T> {
  const outcome = await callSeam<{ value?: T; error?: string }>(app, TEST_CHANNELS.invokeHandler, {
    channel,
    args
  })
  if (outcome.error) throw new Error(outcome.error)
  return outcome.value as T
}

/**
 * Make the next invoke on `channel` reject once its real handler has run.
 * `args` substitutes the renderer's arguments, which is how a spec models a
 * handler whose work partly landed before it failed.
 */
export function failNextInvoke(
  app: ElectronApplication,
  channel: string,
  options: { message: string; args?: unknown[] }
): Promise<void> {
  return emitSeam(app, TEST_CHANNELS.failNextInvoke, { channel, ...options })
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
