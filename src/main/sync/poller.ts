import { EventEmitter } from 'node:events'
import { errorMessage } from '../../shared/error'
import type { Db } from '../db'
import { GmailApiError } from '../gmail/client'
import { applyThreadDelta } from '../store/mutate'
import { replayPendingThreadDeltas } from '../store/replay'
import { type SchedulerTime, systemTime, type TimerHandle } from '../time'
import { hydrateMissingThreadBodies } from './bodies'
import { fetchAndCacheThread } from './fetchThread'
import { deleteThread } from './persist'
import type { HistoryRecord, MailProvider } from './provider'

export interface NewMail {
  threadId: string
  messageId: string
}

export interface CyclePlan {
  refetchThreadIds: string[]
  newMail: NewMail[]
  promoteInboxThreadIds: string[]
}

export interface FetchedHistoryPlan extends CyclePlan {
  historyId: string
}

export const historyEvents = new EventEmitter()

export function planCycle(records: HistoryRecord[]): CyclePlan {
  const refetchThreadIds = new Set<string>()
  const newMail = new Map<string, NewMail>()
  const promoteInboxThreadIds = new Set<string>()

  for (const record of records) {
    for (const message of record.messages ?? []) refetchThreadIds.add(message.threadId)
    for (const event of record.messagesAdded ?? []) {
      const { message } = event
      refetchThreadIds.add(message.threadId)
      const labels = new Set(message.labelIds ?? [])
      if (labels.has('INBOX') && labels.has('UNREAD') && !labels.has('SENT')) {
        newMail.set(message.id, { threadId: message.threadId, messageId: message.id })
      }
      if (labels.has('INBOX')) promoteInboxThreadIds.add(message.threadId)
    }
    for (const event of record.labelsAdded ?? []) {
      if (event.labelIds?.includes('INBOX')) promoteInboxThreadIds.add(event.message.threadId)
    }
    for (const events of [record.messagesDeleted, record.labelsAdded, record.labelsRemoved]) {
      for (const event of events ?? []) refetchThreadIds.add(event.message.threadId)
    }
  }

  return {
    refetchThreadIds: [...refetchThreadIds],
    newMail: [...newMail.values()],
    promoteInboxThreadIds: [...promoteInboxThreadIds]
  }
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

/** Server label membership wins, with still-pending local intent replayed on top. */
export function reconcileLabelMembership(
  db: Db,
  accountId: string,
  labelId: string,
  serverThreadIds: Iterable<string>
): string[] {
  const rows = db
    .prepare('SELECT thread_id FROM thread_labels WHERE account_id = ? AND label_id = ?')
    .all(accountId, labelId) as { thread_id: string }[]
  const missing = missingInboxThreadIds(
    rows.map((row) => row.thread_id),
    serverThreadIds
  )
  for (const threadId of missing) {
    applyThreadDelta(db, accountId, { threadId, add: [], remove: [labelId] })
    replayPendingThreadDeltas(db, accountId, threadId)
  }
  return missing
}

export function reconcileInboxMembership(
  db: Db,
  accountId: string,
  serverInboxThreadIds: Iterable<string>
): string[] {
  return reconcileLabelMembership(db, accountId, 'INBOX', serverInboxThreadIds)
}

/**
 * Spam and Trash age out server-side (~30-day purge), so a locally-labeled
 * thread missing from their listing was either relabeled — a refetch persists
 * the authoritative label set — or permanently deleted, which only a direct
 * 404 may prove. Never conclude deletion from listing absence alone: an
 * archived thread legitimately appears in no system-label listing.
 */
export async function reconcilePurgeableMembership(
  db: Db,
  accountId: string,
  provider: MailProvider,
  labelId: 'SPAM' | 'TRASH',
  serverThreadIds: Iterable<string>,
  effects: HistoryCycleEffects = {}
): Promise<void> {
  for (const threadId of reconcileLabelMembership(db, accountId, labelId, serverThreadIds)) {
    try {
      await (effects.fetchThread ?? fetchAndCacheThread)(db, accountId, provider, threadId, {
        format: 'metadata',
        priority: 'background',
        persistOptions: { metadataOnly: true }
      })
    } catch (error) {
      if (error instanceof GmailApiError && error.status === 404) {
        if (effects.remove) effects.remove(threadId)
        else deleteThread(db, accountId, threadId)
        continue
      }
      throw error
    }
  }
}

export interface HistoryCycleEffects {
  wakeThread?: (threadId: string) => void
  fetchThread?: typeof fetchAndCacheThread
  hydrate?: typeof hydrateMissingThreadBodies
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
  const promoteInbox = new Set(plan.promoteInboxThreadIds)
  for (const threadId of plan.refetchThreadIds) {
    try {
      const { thread } = await (effects.fetchThread ?? fetchAndCacheThread)(
        db,
        accountId,
        provider,
        threadId,
        {
          format: 'full',
          priority: 'polling',
          persistOptions: {
            inboxVisibility: promoteInbox.has(threadId) ? 'show' : 'preserve'
          }
        }
      )
      await (effects.hydrate ?? hydrateMissingThreadBodies)(db, provider, accountId, thread, undefined, {
        priority: 'polling'
      })
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
  db.prepare('UPDATE sync_state SET last_history_id = ? WHERE account_id = ?').run(plan.historyId, accountId)
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
  onCycleStart?: () => void
  onCycleComplete: (changed: boolean) => void
  onError: (error: unknown) => void
  wakeThread?: (threadId: string) => void
  kickExecutor?: () => void
  syncLabels?: () => Promise<boolean | undefined>
  syncSendAs?: () => Promise<void>
  syncDrafts?: () => Promise<boolean | undefined>
  runCycle?: typeof runHistoryCycle
  time?: SchedulerTime
}

export type RunNowRequest = 'started' | 'queued' | 'stopped'

export class HistoryPoller {
  private timer: TimerHandle | null = null
  private executing = false
  private stopped = true
  private lastAttemptAt = 0
  private recoveryPending = false
  private queuedRunStart: (() => void) | null = null
  private readonly time: SchedulerTime

  constructor(private readonly options: HistoryPollerOptions) {
    this.time = options.time ?? systemTime
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.lastAttemptAt = this.time.now()
    console.log(`[sync] history poller started for ${this.options.accountId}`)
    this.schedule()
  }

  stop(): void {
    this.stopped = true
    this.queuedRunStart = null
    if (this.timer) this.time.timers.clearTimeout(this.timer)
    this.timer = null
  }

  requestRunNow(onStarted: () => void): RunNowRequest {
    if (this.stopped) return 'stopped'
    if (this.executing) {
      this.queuedRunStart = onStarted
      return 'queued'
    }
    onStarted()
    void this.runNow()
    return 'started'
  }

  async runNow(): Promise<void> {
    if (this.executing || this.stopped) return
    if (this.timer) this.time.timers.clearTimeout(this.timer)
    this.timer = null
    this.executing = true
    this.lastAttemptAt = this.time.now()
    this.options.onCycleStart?.()
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
      let labelsChanged = false
      if (!this.stopped && this.options.syncLabels) {
        try {
          labelsChanged = (await this.options.syncLabels()) === true
        } catch (error) {
          console.warn(`[sync] label catalog refresh failed: ${errorMessage(error)}`)
        }
      }
      if (!this.stopped && this.options.syncSendAs) {
        try {
          await this.options.syncSendAs()
        } catch (error) {
          console.warn(`[sync] send-as refresh failed: ${errorMessage(error)}`)
        }
      }
      let draftsChanged = false
      if (!this.stopped && this.options.syncDrafts) {
        try {
          draftsChanged = (await this.options.syncDrafts()) === true
        } catch (error) {
          console.warn(`[draft] inbound sync failed: ${errorMessage(error)}`)
        }
      }
      if (this.stopped) return
      this.options.onCycleComplete(
        labelsChanged || draftsChanged || plan === null || plan.refetchThreadIds.length > 0
      )
      this.options.kickExecutor?.()
      // Tagged with the owning account: several pollers share this emitter (F18).
      if (plan && plan.newMail.length > 0) {
        historyEvents.emit('newMail', this.options.accountId, plan.newMail)
      }
    } catch (error) {
      if (!this.stopped) this.options.onError(error)
    } finally {
      this.executing = false
      const queuedRunStart = this.queuedRunStart
      this.queuedRunStart = null
      if (!this.stopped && queuedRunStart) {
        queuedRunStart()
        void this.runNow()
      } else if (!this.stopped) {
        this.schedule()
      }
    }
  }

  private schedule(): void {
    if (this.timer || this.stopped) return
    // Wake at the foreground cadence so a newly focused window does not wait
    // out a previously scheduled 60-second background timer. Network work is
    // still limited to once per minute while no window is focused.
    this.timer = this.time.timers.setTimeout(() => void this.runScheduled(), FOREGROUND_POLL_MS)
  }

  private runScheduled(): void {
    this.timer = null
    const interval = this.options.isForeground() ? FOREGROUND_POLL_MS : BACKGROUND_POLL_MS
    if (this.time.now() - this.lastAttemptAt < interval) {
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
