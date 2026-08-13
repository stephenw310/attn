import { EventEmitter } from 'node:events'
import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import type { GmailThread } from '../gmail/parse'
import { applyThreadDelta } from '../store/mutate'
import { replayPendingThreadDeltas } from '../store/replay'
import { hydrateMissingThreadBodies } from './bodies'
import { deleteThread, persistThread } from './persist'
import type { HistoryRecord, MailProvider } from './provider'

export interface NewMail {
  threadId: string
  messageId: string
}

export interface CyclePlan {
  refetchThreadIds: string[]
  newMail: NewMail[]
}

export interface FetchedHistoryPlan extends CyclePlan {
  historyId: string
}

export const historyEvents = new EventEmitter()

export function planCycle(records: HistoryRecord[]): CyclePlan {
  const refetchThreadIds = new Set<string>()
  const newMail = new Map<string, NewMail>()

  for (const record of records) {
    for (const message of record.messages ?? []) refetchThreadIds.add(message.threadId)
    for (const event of record.messagesAdded ?? []) {
      const { message } = event
      refetchThreadIds.add(message.threadId)
      const labels = new Set(message.labelIds ?? [])
      if (labels.has('INBOX') && labels.has('UNREAD') && !labels.has('SENT')) {
        newMail.set(message.id, { threadId: message.threadId, messageId: message.id })
      }
    }
    for (const events of [record.messagesDeleted, record.labelsAdded, record.labelsRemoved]) {
      for (const event of events ?? []) refetchThreadIds.add(event.message.threadId)
    }
  }

  return { refetchThreadIds: [...refetchThreadIds], newMail: [...newMail.values()] }
}

/** Page history to exhaustion, then reduce all pages as one poll cycle. */
export async function fetchHistoryPlan(
  provider: MailProvider,
  startHistoryId: string
): Promise<FetchedHistoryPlan> {
  const records: HistoryRecord[] = []
  let historyId = startHistoryId
  let pageToken: string | undefined
  do {
    const page = await provider.listHistory(startHistoryId, pageToken)
    records.push(...page.history)
    historyId = maxDecimalId(historyId, page.historyId)
    for (const record of page.history) historyId = maxDecimalId(historyId, record.id)
    pageToken = page.nextPageToken
  } while (pageToken)
  return { ...planCycle(records), historyId }
}

export function missingInboxThreadIds(
  localInboxThreadIds: Iterable<string>,
  serverInboxThreadIds: Iterable<string>
): string[] {
  const server = new Set(serverInboxThreadIds)
  return [...new Set(localInboxThreadIds)].filter((threadId) => !server.has(threadId))
}

/** Server INBOX membership wins, with still-pending local intent replayed on top. */
export function reconcileInboxMembership(
  db: Db,
  accountId: string,
  serverInboxThreadIds: Iterable<string>
): string[] {
  const rows = db
    .prepare("SELECT thread_id FROM thread_labels WHERE account_id = ? AND label_id = 'INBOX'")
    .all(accountId) as { thread_id: string }[]
  const missing = missingInboxThreadIds(
    rows.map((row) => row.thread_id),
    serverInboxThreadIds
  )
  for (const threadId of missing) {
    applyThreadDelta(db, accountId, { threadId, add: [], remove: ['INBOX'] })
    replayPendingThreadDeltas(db, accountId, threadId)
  }
  return missing
}

export interface HistoryCycleEffects {
  wakeThread?: (threadId: string) => void
  persist?: (thread: GmailThread) => Promise<void>
  remove?: (threadId: string) => void
}

export async function runHistoryCycle(
  db: Db,
  accountId: string,
  provider: MailProvider,
  effects: HistoryCycleEffects = {}
): Promise<FetchedHistoryPlan> {
  const state = db.prepare('SELECT last_history_id FROM sync_state WHERE account_id = ?').get(accountId) as
    | { last_history_id: string | null }
    | undefined
  if (!state?.last_history_id) throw new Error(`missing history checkpoint for ${accountId}`)

  const plan = await fetchHistoryPlan(provider, state.last_history_id)
  for (const threadId of plan.refetchThreadIds) {
    try {
      const thread = await provider.getThread(threadId, { format: 'full' })
      if (effects.persist) await effects.persist(thread)
      else {
        persistThread(db, accountId, thread)
        await hydrateMissingThreadBodies(db, provider, accountId, thread)
      }
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) {
        if (effects.remove) effects.remove(threadId)
        else deleteThread(db, accountId, threadId)
        continue
      }
      throw error
    }
  }
  for (const threadId of new Set(plan.newMail.map((mail) => mail.threadId))) {
    effects.wakeThread?.(threadId)
  }
  db.prepare('UPDATE sync_state SET last_history_id = ?, updated_at = ? WHERE account_id = ?').run(
    plan.historyId,
    Date.now(),
    accountId
  )
  return plan
}

export const FOREGROUND_POLL_MS = 15_000
export const BACKGROUND_POLL_MS = 60_000

export interface HistoryPollerOptions {
  db: Db
  accountId: string
  provider: MailProvider
  isForeground: () => boolean
  recoverExpiredHistory: () => Promise<void>
  onCycleComplete: (changed: boolean) => void
  onError: (error: unknown) => void
  wakeThread?: (threadId: string) => void
  kickExecutor?: () => void
  runCycle?: typeof runHistoryCycle
}

export class HistoryPoller {
  private timer: ReturnType<typeof setTimeout> | null = null
  private executing = false
  private stopped = true
  private lastAttemptAt = 0
  private recoveryPending = false

  constructor(private readonly options: HistoryPollerOptions) {}

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.lastAttemptAt = Date.now()
    console.log(`[sync] history poller started for ${this.options.accountId}`)
    this.schedule()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  async runNow(): Promise<void> {
    if (this.executing || this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.executing = true
    this.lastAttemptAt = Date.now()
    try {
      let plan: FetchedHistoryPlan | null = null
      if (this.recoveryPending) {
        await this.options.recoverExpiredHistory()
        this.recoveryPending = false
      } else {
        try {
          plan = await (this.options.runCycle ?? runHistoryCycle)(
            this.options.db,
            this.options.accountId,
            this.options.provider,
            { wakeThread: this.options.wakeThread }
          )
        } catch (error) {
          if (!(error instanceof GmailApiError) || error.status !== 404) throw error
          console.warn('[sync] history checkpoint expired — running delta re-list')
          this.recoveryPending = true
          await this.options.recoverExpiredHistory()
          this.recoveryPending = false
        }
      }
      if (this.stopped) return
      this.options.onCycleComplete(plan === null || plan.refetchThreadIds.length > 0)
      this.options.kickExecutor?.()
      if (plan && plan.newMail.length > 0) historyEvents.emit('newMail', plan.newMail)
    } catch (error) {
      if (!this.stopped) this.options.onError(error)
    } finally {
      this.executing = false
      if (!this.stopped) this.schedule()
    }
  }

  private schedule(): void {
    if (this.timer || this.stopped) return
    // Wake at the foreground cadence so a newly focused window does not wait
    // out a previously scheduled 60-second background timer. Network work is
    // still limited to once per minute while no window is focused.
    this.timer = setTimeout(() => void this.runScheduled(), FOREGROUND_POLL_MS)
  }

  private runScheduled(): void {
    this.timer = null
    const interval = this.options.isForeground() ? FOREGROUND_POLL_MS : BACKGROUND_POLL_MS
    if (Date.now() - this.lastAttemptAt < interval) {
      this.schedule()
      return
    }
    void this.runNow()
  }
}

function maxDecimalId(left: string, right: string): string {
  try {
    return BigInt(right) > BigInt(left) ? right : left
  } catch {
    return right > left ? right : left
  }
}
