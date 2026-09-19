import { useCallback, useEffect, useRef, useState } from 'react'
import type { Draft } from '../../../shared/drafts'
import {
  type MailLabel,
  type SnoozedThreadRow,
  type SyncState,
  type SystemMailboxCounts,
  THREAD_PAGE_SIZE,
  type ThreadPage,
  type ThreadPageCursor,
  type ThreadRow
} from '../../../shared/mail'
import type { OutboxChanged, OutboxItem, OutboxProgress } from '../../../shared/outbox'
import { reuseLabels, reuseSnoozedRows, reuseThreadRows } from '../list/mailDataEquality'
import {
  type CachedThreadView,
  cachedThreadView,
  labelMailboxView,
  type MailView,
  type PagedThreadView,
  userLabelId
} from '../list/mailDisplay'
import { refreshedSelectionIndex } from '../selection'

/** Cached rows per system mailbox or user-label view, kept across pure switches. */
export type MailboxRowCache = Record<string, ThreadRow[] | undefined>

export interface ThreadPaginationState {
  nextCursor: ThreadPageCursor | null
  loadingMore: boolean
}

export type ThreadPagination = Record<string, ThreadPaginationState | undefined>

interface InboxSplitCacheEntry {
  rows: ThreadRow[]
  pagination: ThreadPaginationState
  splitRevision: number | null
  stale: boolean
}

function listThreadPage(
  view: PagedThreadView,
  cursor?: ThreadPageCursor,
  splitId?: string
): Promise<ThreadPage> {
  const bridge = window.attn
  if (!bridge) return Promise.resolve({ rows: [], nextCursor: null })
  if (view === 'inbox') return bridge.mail.listThreadPage('inbox', cursor, splitId)
  if (view === 'snoozed') return bridge.mail.listSnoozedPage(cursor)
  const mailbox = labelMailboxView(view)
  return mailbox
    ? bridge.mail.listThreadPage(mailbox, cursor)
    : bridge.mail.listLabelThreadPage(userLabelId(view) ?? '', cursor)
}

interface RunRefreshOptions {
  /** True once the caller's subscription (or its account) is gone. */
  isStale: () => boolean
  /** A mail-changed refresh drops the other cached label views; a targeted one keeps them. */
  pruneCachedViews: boolean
  splitId: string | null
  splitRevision: number | null
}

interface ThreadSnapshotOptions {
  targetThreadId?: string
  splitId?: string
  expectedSplitRevision?: number
}

async function listThreadSnapshot(
  view: PagedThreadView,
  minimumRows: number,
  options: ThreadSnapshotOptions = {}
): Promise<ThreadPage> {
  const rows: ThreadRow[] = []
  let cursor: ThreadPageCursor | undefined
  let nextCursor: ThreadPageCursor | null = null
  let foundTarget = options.targetThreadId === undefined
  let splitRevision: number | undefined
  do {
    const page = await listThreadPage(view, cursor, options.splitId)
    if (options.splitId) {
      splitRevision ??= page.splitRevision
      if (
        page.splitRevision === undefined ||
        page.splitRevision !== splitRevision ||
        (options.expectedSplitRevision !== undefined && page.splitRevision !== options.expectedSplitRevision)
      ) {
        throw new Error('Split rules changed while loading the Inbox')
      }
    }
    rows.push(...page.rows)
    if (!foundTarget) foundTarget = page.rows.some((row) => row.id === options.targetThreadId)
    nextCursor = page.nextCursor
    cursor = page.nextCursor ?? undefined
  } while (nextCursor && (rows.length < Math.max(THREAD_PAGE_SIZE, minimumRows) || !foundTarget))
  return { rows, nextCursor, ...(splitRevision === undefined ? {} : { splitRevision }) }
}

function appendUniqueRows<Row extends ThreadRow>(current: Row[], next: Row[]): Row[] {
  if (next.length === 0) return current
  const ids = new Set(current.map((row) => row.id))
  const additions = next.filter((row) => !ids.has(row.id))
  return additions.length === 0 ? current : [...current, ...additions]
}

interface MailDataState {
  sync: SyncState
  inboxBackfillReady: boolean | null
  networkOnline: boolean
  realThreads: ThreadRow[] | null
  setRealThreads: React.Dispatch<React.SetStateAction<ThreadRow[] | null>>
  loadedInboxSplitId: string | null
  loadedInboxSplitStale: boolean
  activateInboxSplitCache: (splitId: string) => boolean
  preloadInboxSplits: (splitIds: readonly string[]) => void
  realSnoozedThreads: SnoozedThreadRow[] | null
  setRealSnoozedThreads: React.Dispatch<React.SetStateAction<SnoozedThreadRow[] | null>>
  mailboxRows: MailboxRowCache
  setMailboxRows: React.Dispatch<React.SetStateAction<MailboxRowCache>>
  refreshCachedThreadView: (view: CachedThreadView) => Promise<void>
  threadPagination: ThreadPagination
  loadMoreThreads: (view: PagedThreadView) => Promise<void>
  focusInboxThread: (
    threadId: string,
    splitId?: string | null,
    splitRevision?: number
  ) => Promise<number | null>
  focusMailboxThread: (threadId: string, view: 'allMail' | 'spam' | 'trash') => Promise<number | null>
  realDrafts: Draft[]
  realOutbox: OutboxItem[]
  outboxFailure: Extract<OutboxChanged, { kind: 'failed' }> | null
  outboxProgress: OutboxProgress | null
  clearOutboxFailure: () => void
  refreshDrafts: () => Promise<void>
  refreshMailRows: () => Promise<void>
  realMailboxCounts: SystemMailboxCounts | null
  labels: MailLabel[]
  pendingActionCount: number
  pausedActionCount: number
  mailRevision: number
  mailChangeSource: string | null
  invalidateConversations: () => void
  preserveSelectionOnRefreshRef: React.RefObject<boolean>
  deferRefreshUntilRef: React.RefObject<number>
}

export function useMailData(
  activeAccount: string | null,
  activeSplitId: string | null,
  splitRevisionValue: number | null,
  activeViewRef: React.RefObject<MailView>,
  selectedThreadIdRef: React.RefObject<string | null>,
  selectedDraftIdRef: React.RefObject<string | null>,
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>,
  splitsReady = true,
  /** True while the Inbox list itself is the surface on screen (F11). */
  inboxListOnScreen = true
): MailDataState {
  const [sync, setSync] = useState<SyncState>({ phase: 'idle' })
  const [inboxBackfillReady, setInboxBackfillReady] = useState<boolean | null>(null)
  const [networkOnline, setNetworkOnline] = useState(() => navigator.onLine)
  const [realThreads, setRealThreads] = useState<ThreadRow[] | null>(null)
  const [loadedInboxSplitId, setLoadedInboxSplitId] = useState<string | null>(null)
  const [loadedInboxSplitStale, setLoadedInboxSplitStale] = useState(false)
  const [realSnoozedThreads, setRealSnoozedThreads] = useState<SnoozedThreadRow[] | null>(null)
  const [mailboxRows, setMailboxRows] = useState<MailboxRowCache>({})
  const [threadPagination, setThreadPagination] = useState<ThreadPagination>({})
  const [realDrafts, setRealDrafts] = useState<Draft[]>([])
  const [realOutbox, setRealOutbox] = useState<OutboxItem[]>([])
  const [outboxFailure, setOutboxFailure] = useState<Extract<OutboxChanged, { kind: 'failed' }> | null>(null)
  const [outboxProgress, setOutboxProgress] = useState<OutboxProgress | null>(null)
  const [realMailboxCounts, setRealMailboxCounts] = useState<SystemMailboxCounts | null>(null)
  const [labels, setLabels] = useState<MailLabel[]>([])
  const [pendingActionCount, setPendingActionCount] = useState(0)
  const [pausedActionCount, setPausedActionCount] = useState(0)
  const [mailRevision, setMailRevision] = useState(0)
  const [mailChangeSource, setMailChangeSource] = useState<string | null>(null)
  const invalidateConversations = useCallback(() => {
    setMailChangeSource(null)
    setMailRevision((revision) => revision + 1)
  }, [])
  const preserveSelectionOnRefreshRef = useRef(true)
  const deferRefreshUntilRef = useRef(0)
  const deferGateRef = useRef<Promise<void> | null>(null)
  const mailboxRefreshVersionRef = useRef<Record<string, number | undefined>>({})
  const loadMoreInFlightRef = useRef(new Set<PagedThreadView>())
  const inboxSplitCacheRef = useRef(new Map<string, InboxSplitCacheEntry>())
  const inboxSplitPreloadRef = useRef(0)
  const inboxSplitChangeRef = useRef(0)
  const inboxReadyRequestRef = useRef(0)
  const effectAccountRef = useRef<string | null | undefined>(undefined)
  const effectSplitIdRef = useRef<string | null | undefined>(undefined)
  const effectSplitRevisionRef = useRef<number | null | undefined>(undefined)
  const inboxListOnScreenRef = useRef(inboxListOnScreen)
  inboxListOnScreenRef.current = inboxListOnScreen
  // A stored judgment waiting for the list to come back, and the live refresh
  // that will read it. Both outlive one run of the subscription effect below.
  const deferredSplitRefreshRef = useRef(false)
  const refreshRef = useRef<(() => void) | null>(null)
  const threadPaginationRef = useRef(threadPagination)
  threadPaginationRef.current = threadPagination
  const loadedRowCountsRef = useRef<Record<string, number | undefined>>({})
  loadedRowCountsRef.current = {
    inbox: realThreads?.length ?? 0,
    snoozed: realSnoozedThreads?.length ?? 0,
    ...Object.fromEntries(Object.entries(mailboxRows).map(([view, rows]) => [view, rows?.length ?? 0]))
  }
  const activeAccountRef = useRef(activeAccount)
  activeAccountRef.current = activeAccount
  const mailboxCountsRequestRef = useRef(0)
  const refreshMailboxCounts = useCallback(() => {
    const bridge = window.attn
    if (!bridge || !activeAccount) return
    const request = ++mailboxCountsRequestRef.current
    void bridge.mail
      .getMailboxCounts()
      .then((counts) => {
        if (activeAccountRef.current === activeAccount && mailboxCountsRequestRef.current === request) {
          setRealMailboxCounts(counts)
        }
      })
      .catch(() => {})
  }, [activeAccount])
  const activeSplitIdRef = useRef(activeSplitId)
  activeSplitIdRef.current = activeSplitId
  const splitRevisionRef = useRef(splitRevisionValue)
  splitRevisionRef.current = splitRevisionValue
  const clearOutboxFailure = useCallback(() => setOutboxFailure(null), [])

  useEffect(() => {
    if (!loadedInboxSplitId || realThreads === null) return
    inboxSplitCacheRef.current.set(loadedInboxSplitId, {
      rows: realThreads,
      pagination: threadPagination.inbox ?? { nextCursor: null, loadingMore: false },
      splitRevision: splitRevisionRef.current,
      stale: loadedInboxSplitStale
    })
  }, [loadedInboxSplitId, loadedInboxSplitStale, realThreads, threadPagination.inbox])

  const activateInboxSplitCache = useCallback((splitId: string): boolean => {
    const cached = inboxSplitCacheRef.current.get(splitId)
    if (!cached || cached.splitRevision !== splitRevisionRef.current) return false
    setRealThreads(cached.rows)
    setLoadedInboxSplitId(splitId)
    setLoadedInboxSplitStale(cached.stale)
    setThreadPagination((current) => ({ ...current, inbox: cached.pagination }))
    return true
  }, [])

  const preloadInboxSplits = useCallback((splitIds: readonly string[]): void => {
    const account = activeAccountRef.current
    const splitRevision = splitRevisionRef.current
    if (!account || splitRevision === null || !window.attn) return
    const preload = ++inboxSplitPreloadRef.current
    const activeIndex = activeSplitIdRef.current ? splitIds.indexOf(activeSplitIdRef.current) : -1
    const orderedSplitIds =
      activeIndex < 0
        ? splitIds
        : Array.from({ length: splitIds.length - 1 }, (_, index) => {
            const distance = Math.floor(index / 2) + 1
            const direction = index % 2 === 0 ? 1 : -1
            return splitIds[(activeIndex + direction * distance + splitIds.length) % splitIds.length]
          }).filter((splitId, index, ordered) => ordered.indexOf(splitId) === index)
    void (async () => {
      for (const splitId of orderedSplitIds) {
        if (
          preload !== inboxSplitPreloadRef.current ||
          activeAccountRef.current !== account ||
          splitRevisionRef.current !== splitRevision
        ) {
          return
        }
        if (splitId === activeSplitIdRef.current) continue
        if (inboxSplitCacheRef.current.get(splitId)?.splitRevision === splitRevision) continue
        const change = inboxSplitChangeRef.current
        try {
          const page = await listThreadSnapshot('inbox', 0, {
            splitId,
            expectedSplitRevision: splitRevision
          })
          if (
            preload !== inboxSplitPreloadRef.current ||
            activeAccountRef.current !== account ||
            splitRevisionRef.current !== splitRevision
          ) {
            return
          }
          inboxSplitCacheRef.current.set(splitId, {
            rows: page.rows,
            pagination: { nextCursor: page.nextCursor, loadingMore: false },
            splitRevision,
            stale: inboxSplitChangeRef.current !== change
          })
        } catch {
          // The selected split still has the ordinary demand-load path. A
          // preload failure must not surface as a user-visible error.
        }
      }
    })()
  }, [])

  useEffect(() => {
    if (!window.attn) return
    window.attn.sync
      .getState()
      .then(setSync)
      .catch(() => {})
    return window.attn.sync.onState(setSync)
  }, [])

  useEffect(() => {
    const bridge = window.attn
    if (!bridge || !activeAccount) {
      inboxReadyRequestRef.current += 1
      setInboxBackfillReady(null)
      return
    }
    let stateKey = ''
    const refresh = (): void => {
      const request = ++inboxReadyRequestRef.current
      void bridge.sync
        .getInboxReady()
        .then((ready) => {
          if (request === inboxReadyRequestRef.current) setInboxBackfillReady(ready)
        })
        .catch(() => {
          if (request === inboxReadyRequestRef.current) setInboxBackfillReady(false)
        })
    }
    refresh()
    const offState = bridge.sync.onState((next) => {
      const nextKey = next.phase === 'syncing' ? `${next.phase}:${next.stage}` : next.phase
      if (nextKey === stateKey) return
      stateKey = nextKey
      refresh()
    })
    // A judgment moves a conversation between splits. It finishes no backfill
    // phase, so the readiness answer cannot have changed.
    const offMail = bridge.mail.onChanged((_serverSearchRequestId, reason) => {
      if (reason !== 'split-judgments') refresh()
    })
    return () => {
      offState()
      offMail()
    }
  }, [activeAccount])

  useEffect(() => {
    const onOffline = (): void => setNetworkOnline(false)
    const onOnline = (): void => {
      setNetworkOnline(true)
      void window.attn?.sync.retry().catch(() => {})
    }
    window.addEventListener('offline', onOffline)
    window.addEventListener('online', onOnline)
    return () => {
      window.removeEventListener('offline', onOffline)
      window.removeEventListener('online', onOnline)
    }
  }, [])

  /**
   * The one snapshot read: visible rows, drafts, outbox, selection and
   * pagination for the active view. Both callers — the event-driven refresh
   * below and `refreshMailRows` — go through it, so neither can drift into
   * reading a different list than the one it resolves the selection against.
   */
  const runRefresh = useCallback(
    async (options: RunRefreshOptions): Promise<void> => {
      const bridge = window.attn
      if (!bridge) return
      const preserveSelection = preserveSelectionOnRefreshRef.current
      preserveSelectionOnRefreshRef.current = true
      const viewAtStart = activeViewRef.current
      const extraView = cachedThreadView(viewAtStart)
      const inboxSplitId = options.splitId
      const inboxChange = inboxSplitChangeRef.current
      const inboxVersion = (mailboxRefreshVersionRef.current.inbox ?? 0) + 1
      const snoozedVersion = (mailboxRefreshVersionRef.current.snoozed ?? 0) + 1
      const extraViewVersion = extraView ? (mailboxRefreshVersionRef.current[extraView] ?? 0) + 1 : null
      mailboxRefreshVersionRef.current.inbox = inboxVersion
      mailboxRefreshVersionRef.current.snoozed = snoozedVersion
      if (extraView && extraViewVersion !== null) {
        mailboxRefreshVersionRef.current[extraView] = extraViewVersion
      }
      // Queue visible rows before aggregate counts on the utility process's
      // synchronous SQLite connection. Each result paints independently.
      const [inboxPage, snoozedPage, drafts, outbox, extraPage] = await Promise.all([
        listThreadSnapshot('inbox', loadedRowCountsRef.current.inbox ?? 0, {
          splitId: options.splitId ?? undefined,
          expectedSplitRevision: options.splitRevision ?? undefined
        }),
        listThreadSnapshot('snoozed', loadedRowCountsRef.current.snoozed ?? 0),
        bridge.draft.list(),
        bridge.outbox.listPending(),
        extraView
          ? listThreadSnapshot(extraView, loadedRowCountsRef.current[extraView] ?? 0)
          : Promise.resolve(null)
      ])
      if (options.isStale()) return
      const viewStillCurrent = activeViewRef.current === viewAtStart
      const inboxStillCurrent = mailboxRefreshVersionRef.current.inbox === inboxVersion
      const snoozedStillCurrent = mailboxRefreshVersionRef.current.snoozed === snoozedVersion
      const extraViewStillCurrent =
        !extraView || mailboxRefreshVersionRef.current[extraView] === extraViewVersion
      const visibleStillCurrent =
        viewAtStart === 'inbox'
          ? inboxStillCurrent
          : viewAtStart === 'snoozed'
            ? snoozedStillCurrent
            : extraViewStillCurrent
      // A targeted focus can supersede this read. Its rows and selection
      // must stay together, even when the older refresh finishes later.
      if (viewStillCurrent && visibleStillCurrent) {
        const visible =
          viewAtStart === 'inbox'
            ? inboxPage.rows
            : viewAtStart === 'snoozed'
              ? snoozedPage.rows
              : viewAtStart === 'drafts'
                ? drafts
                : viewAtStart === 'outbox'
                  ? outbox
                  : (extraPage?.rows ?? [])
        const selectedId =
          viewAtStart === 'drafts' || viewAtStart === 'outbox'
            ? selectedDraftIdRef.current
            : selectedThreadIdRef.current
        setSelectedIndex((current) =>
          refreshedSelectionIndex(visible, preserveSelection ? selectedId : null, current)
        )
      }
      if (inboxStillCurrent) {
        setRealThreads((current) => reuseThreadRows(current, inboxPage.rows))
        setLoadedInboxSplitId(inboxSplitId)
        setLoadedInboxSplitStale(inboxSplitChangeRef.current !== inboxChange)
      }
      if (snoozedStillCurrent) {
        setRealSnoozedThreads((current) => reuseSnoozedRows(current, snoozedPage.rows as SnoozedThreadRow[]))
      }
      if (viewStillCurrent && extraViewStillCurrent) {
        // After a mail change the cached rows for the other label-driven views
        // are stale: keep only the view this refresh just re-read. A refresh
        // started for an older view must not erase rows fetched after a
        // mailbox switch. A targeted refresh leaves the other caches alone.
        if (options.pruneCachedViews) {
          setMailboxRows(() =>
            extraView && extraPage ? { [extraView]: reuseThreadRows(null, extraPage.rows) } : {}
          )
        } else if (extraView && extraPage) {
          setMailboxRows((current) => ({
            ...current,
            [extraView]: reuseThreadRows(current[extraView] ?? null, extraPage.rows)
          }))
        }
      }
      setThreadPagination((current) => {
        const next: ThreadPagination =
          options.pruneCachedViews && viewStillCurrent && extraViewStillCurrent
            ? { inbox: current.inbox, snoozed: current.snoozed }
            : { ...current }
        if (inboxStillCurrent) {
          next.inbox = { nextCursor: inboxPage.nextCursor, loadingMore: false }
        }
        if (snoozedStillCurrent) {
          next.snoozed = { nextCursor: snoozedPage.nextCursor, loadingMore: false }
        }
        if (viewStillCurrent && extraViewStillCurrent && extraView && extraPage) {
          next[extraView] = { nextCursor: extraPage.nextCursor, loadingMore: false }
        }
        return next
      })
      setRealDrafts(drafts)
      setRealOutbox(outbox)
      setOutboxProgress((current) =>
        current && outbox.some((item) => item.id === current.id && item.state === 'sending') ? current : null
      )
    },
    [activeViewRef, selectedDraftIdRef, selectedThreadIdRef, setSelectedIndex]
  )

  useEffect(() => {
    const accountChanged = effectAccountRef.current !== activeAccount
    const splitChanged = effectSplitIdRef.current !== activeSplitId
    const revisionChanged = effectSplitRevisionRef.current !== splitRevisionValue
    effectAccountRef.current = activeAccount
    effectSplitIdRef.current = activeSplitId
    effectSplitRevisionRef.current = splitRevisionValue
    // A judging pass bumps the split revision before it broadcasts, so its
    // change arrives here as a revision change. The loaded rows survive it:
    // only the cached pages of the other splits are dropped, and the re-read
    // waits until the Inbox list is the surface on screen again.
    const judgmentOnly = deferredSplitRefreshRef.current && !accountChanged && !splitChanged
    if (accountChanged || revisionChanged) {
      inboxSplitPreloadRef.current += 1
      inboxSplitChangeRef.current += 1
    }
    if (accountChanged) {
      inboxSplitCacheRef.current.clear()
      setRealThreads(null)
      setLoadedInboxSplitId(null)
      setLoadedInboxSplitStale(false)
      setRealSnoozedThreads(null)
      setMailboxRows({})
      setThreadPagination({})
      setRealDrafts([])
      setRealOutbox([])
      setOutboxFailure(null)
      setOutboxProgress(null)
      setRealMailboxCounts(null)
      setInboxBackfillReady(null)
      setLabels([])
      setPendingActionCount(0)
      setPausedActionCount(0)
      setMailRevision(0)
      setMailChangeSource(null)
      mailboxRefreshVersionRef.current = {}
      loadMoreInFlightRef.current.clear()
      loadedRowCountsRef.current = {}
      preserveSelectionOnRefreshRef.current = true
    } else {
      if (revisionChanged) inboxSplitCacheRef.current.clear()
      // A judgment leaves the loaded rows exactly as they are. Everything else
      // reloads them, from the cache for this split where it is still valid.
      if (!judgmentOnly) {
        const candidate = activeSplitId ? inboxSplitCacheRef.current.get(activeSplitId) : undefined
        const cached = candidate?.splitRevision === splitRevisionValue ? candidate : undefined
        setRealThreads(cached?.rows ?? null)
        setLoadedInboxSplitId(cached && activeSplitId ? activeSplitId : null)
        setLoadedInboxSplitStale(cached?.stale ?? false)
        setThreadPagination((current) => {
          const next = { ...current }
          if (cached) next.inbox = cached.pagination
          else delete next.inbox
          return next
        })
        mailboxRefreshVersionRef.current.inbox = (mailboxRefreshVersionRef.current.inbox ?? 0) + 1
        loadMoreInFlightRef.current.delete('inbox')
        preserveSelectionOnRefreshRef.current = true
      }
    }
    const bridge = window.attn
    if (!bridge || !activeAccount || !splitsReady) return
    let cancelled = false
    let deferredRefreshTimer: number | null = null
    let mailChangedPending = false
    let pendingMailChangeSource: string | null | undefined
    let refreshInFlight = false
    let refreshQueued = false
    // Judgments move conversations between splits. They change no mailbox
    // total, no label, and no queued action, so a run that only carries them
    // reads the rows alone. Any other event restores the whole snapshot.
    let countsPending = !judgmentOnly
    const refresh = (): void => {
      if (cancelled) return
      const delay = deferRefreshUntilRef.current - Date.now()
      if (delay > 0) {
        if (deferredRefreshTimer !== null) window.clearTimeout(deferredRefreshTimer)
        deferredRefreshTimer = window.setTimeout(refresh, delay)
        return
      }
      if (refreshInFlight) {
        refreshQueued = true
        return
      }
      refreshInFlight = true
      const includeCounts = countsPending
      countsPending = false
      // Past the defer gate, so conversation caches age out with the thread list
      // rather than once per raw event: a burst during backfill, or an archive
      // animation holding the refresh, invalidates once instead of per event.
      if (mailChangedPending) {
        mailChangedPending = false
        setMailChangeSource(pendingMailChangeSource ?? null)
        pendingMailChangeSource = undefined
        setMailRevision((revision) => revision + 1)
      }
      const refreshingRows = runRefresh({
        isStale: () => cancelled,
        pruneCachedViews: true,
        splitId: activeSplitId ?? null,
        splitRevision: splitRevisionValue
      })
      // Queue counts after the visible reads, but do not wait for their IPC
      // responses or unrelated labels/drafts before showing the new totals.
      if (includeCounts) refreshMailboxCounts()
      void refreshingRows
        .then(async () => {
          if (cancelled || !includeCounts) return
          const [nextLabels, actionStatus] = await Promise.all([
            bridge.mail.listLabels(),
            bridge.mail.getActionQueueStatus()
          ])
          if (cancelled) return
          setLabels((current) => reuseLabels(current, nextLabels))
          setPendingActionCount(actionStatus.pending)
          setPausedActionCount(actionStatus.paused)
        })
        .catch(() => {})
        .finally(() => {
          refreshInFlight = false
          if (!refreshQueued || cancelled) return
          refreshQueued = false
          refresh()
        })
    }
    refreshRef.current = refresh
    // A judgment read waits while the Inbox list is off screen: the flag stays
    // set, and the flush effect below reads when the list comes back.
    if (!judgmentOnly || inboxListOnScreenRef.current) {
      deferredSplitRefreshRef.current = false
      refresh()
    }
    const offMail = bridge.mail.onChanged((serverSearchRequestId, reason) => {
      // Inactive split pages remain useful immediately after ordinary mail
      // writes. Keep them visible on the next switch, then re-read that split
      // through this effect so stale rows converge without a blank frame.
      inboxSplitChangeRef.current += 1
      for (const cached of inboxSplitCacheRef.current.values()) cached.stale = true
      if (reason === 'split-judgments') {
        // The pass bumped the split revision before it announced itself, so
        // this effect re-runs with that revision and owns the read. Reading
        // here would ask for rows at a revision SQLite has already left.
        deferredSplitRefreshRef.current = true
        return
      }
      if (activeSplitIdRef.current) setLoadedInboxSplitStale(true)
      // A full refresh subsumes a judgment waiting for the list to come back.
      deferredSplitRefreshRef.current = false
      countsPending = true
      pendingMailChangeSource = mailChangedPending
        ? pendingMailChangeSource === serverSearchRequestId
          ? pendingMailChangeSource
          : null
        : serverSearchRequestId
      mailChangedPending = true
      refresh()
    })
    const offOutbox = bridge.outbox.onChanged((change) => {
      inboxSplitChangeRef.current += 1
      for (const cached of inboxSplitCacheRef.current.values()) cached.stale = true
      if (activeSplitIdRef.current) setLoadedInboxSplitStale(true)
      if (change.kind === 'failed') setOutboxFailure(change)
      // Reply/forward rows are projected into the open conversation while
      // queued, so outbox transitions invalidate that cache as well as lists.
      deferredSplitRefreshRef.current = false
      countsPending = true
      pendingMailChangeSource = null
      mailChangedPending = true
      refresh()
    })
    const offProgress = bridge.outbox.onProgress(setOutboxProgress)
    return () => {
      cancelled = true
      inboxSplitPreloadRef.current += 1
      mailboxCountsRequestRef.current += 1
      if (deferredRefreshTimer !== null) window.clearTimeout(deferredRefreshTimer)
      refreshRef.current = null
      offMail()
      offOutbox()
      offProgress()
    }
  }, [activeAccount, activeSplitId, splitRevisionValue, splitsReady, refreshMailboxCounts, runRefresh])

  // The deferred judgment read. It must stay below the subscription effect:
  // when both run in one commit, that effect installs the current `refresh`
  // before this one calls it.
  useEffect(() => {
    if (!inboxListOnScreen || !deferredSplitRefreshRef.current) return
    deferredSplitRefreshRef.current = false
    refreshRef.current?.()
  }, [inboxListOnScreen])

  // One shared wait behind the defer gate, mirroring the coalescing timer the
  // event-driven refresh above uses: N closes during one triage animation
  // resume as one burst instead of N independent query storms.
  const awaitRefreshGate = useCallback(async (): Promise<void> => {
    if (deferRefreshUntilRef.current <= Date.now()) return
    if (!deferGateRef.current) {
      deferGateRef.current = (async () => {
        // The gate can be pushed forward while we wait, so re-read it rather
        // than sleeping once against a stale deadline.
        while (deferRefreshUntilRef.current > Date.now()) {
          const delay = deferRefreshUntilRef.current - Date.now()
          await new Promise<void>((resolve) => window.setTimeout(resolve, delay))
        }
        deferGateRef.current = null
      })()
    }
    await deferGateRef.current
  }, [])

  const refreshDrafts = useCallback(async (): Promise<void> => {
    const account = activeAccount
    if (!window.attn || !account) return
    await awaitRefreshGate()
    if (!window.attn || activeAccountRef.current !== account) return
    const drafts = await window.attn.draft.list()
    if (activeViewRef.current === 'drafts') {
      const preserveSelection = preserveSelectionOnRefreshRef.current
      preserveSelectionOnRefreshRef.current = true
      setSelectedIndex((current) =>
        refreshedSelectionIndex(drafts, preserveSelection ? selectedDraftIdRef.current : null, current)
      )
    }
    setRealDrafts(drafts)
  }, [activeAccount, activeViewRef, awaitRefreshGate, selectedDraftIdRef, setSelectedIndex])

  const refreshMailRows = useCallback(async (): Promise<void> => {
    const account = activeAccount
    if (!window.attn || !account) return
    await awaitRefreshGate()
    if (!window.attn || activeAccountRef.current !== account) return
    await runRefresh({
      isStale: () => activeAccountRef.current !== account,
      // Targeted refresh after a local action: the other cached label views
      // were not invalidated, so leave them in place.
      pruneCachedViews: false,
      splitId: activeSplitIdRef.current ?? null,
      splitRevision: splitRevisionRef.current
    })
    if (activeAccountRef.current !== account) return
    refreshMailboxCounts()
  }, [activeAccount, awaitRefreshGate, refreshMailboxCounts, runRefresh])

  /**
   * Read one label-driven view's rows without touching the rest of the
   * snapshot. View switches call this so a first visit fills the cache and a
   * return revalidates it in the background while cached rows render. Stable
   * identity: view-switch callbacks depend on it, and losing stability would
   * resubscribe every effect built on top of switching.
   */
  const refreshCachedThreadView = useCallback(async (view: CachedThreadView): Promise<void> => {
    const account = activeAccountRef.current
    if (!window.attn || !account) return
    const version = (mailboxRefreshVersionRef.current[view] ?? 0) + 1
    mailboxRefreshVersionRef.current[view] = version
    const page = await listThreadSnapshot(view, loadedRowCountsRef.current[view] ?? 0)
    if (
      !window.attn ||
      activeAccountRef.current !== account ||
      mailboxRefreshVersionRef.current[view] !== version
    ) {
      return
    }
    setMailboxRows((current) => ({
      ...current,
      [view]: reuseThreadRows(current[view] ?? null, page.rows)
    }))
    setThreadPagination((current) => ({
      ...current,
      [view]: { nextCursor: page.nextCursor, loadingMore: false }
    }))
  }, [])

  const loadMoreThreads = useCallback(async (view: PagedThreadView): Promise<void> => {
    const account = activeAccountRef.current
    const pageState = threadPaginationRef.current[view]
    if (!window.attn || !account || !pageState?.nextCursor || loadMoreInFlightRef.current.has(view)) {
      return
    }
    const version = mailboxRefreshVersionRef.current[view] ?? 0
    loadMoreInFlightRef.current.add(view)
    setThreadPagination((current) => ({
      ...current,
      [view]: { ...current[view], nextCursor: pageState.nextCursor, loadingMore: true }
    }))
    try {
      const splitId = view === 'inbox' ? (activeSplitIdRef.current ?? undefined) : undefined
      const page = await listThreadPage(view, pageState.nextCursor, splitId)
      if (splitId && (page.splitRevision === undefined || page.splitRevision !== splitRevisionRef.current)) {
        return
      }
      if (activeAccountRef.current !== account || mailboxRefreshVersionRef.current[view] !== version) {
        return
      }
      if (view === 'inbox') {
        setRealThreads((current) => appendUniqueRows(current ?? [], page.rows))
        setLoadedInboxSplitId(splitId ?? null)
      } else if (view === 'snoozed') {
        setRealSnoozedThreads((current) => appendUniqueRows(current ?? [], page.rows as SnoozedThreadRow[]))
      } else {
        setMailboxRows((current) => ({
          ...current,
          [view]: appendUniqueRows(current[view] ?? [], page.rows)
        }))
      }
      setThreadPagination((current) => ({
        ...current,
        [view]: { nextCursor: page.nextCursor, loadingMore: false }
      }))
    } catch {
      if (activeAccountRef.current === account && mailboxRefreshVersionRef.current[view] === version) {
        setThreadPagination((current) => ({
          ...current,
          [view]: { nextCursor: pageState.nextCursor, loadingMore: false }
        }))
      }
    } finally {
      loadMoreInFlightRef.current.delete(view)
    }
  }, [])

  const focusInboxThread = useCallback(
    async (
      threadId: string,
      splitId: string | null | undefined = undefined,
      expectedSplitRevision = splitRevisionRef.current ?? undefined
    ): Promise<number | null> => {
      const account = activeAccountRef.current
      if (!window.attn || !account) return null
      const targetSplitId =
        splitId === undefined ? (activeSplitIdRef.current ?? undefined) : (splitId ?? undefined)
      const version = (mailboxRefreshVersionRef.current.inbox ?? 0) + 1
      const inboxChange = inboxSplitChangeRef.current
      mailboxRefreshVersionRef.current.inbox = version
      const page = await listThreadSnapshot('inbox', loadedRowCountsRef.current.inbox ?? 0, {
        targetThreadId: threadId,
        splitId: targetSplitId,
        expectedSplitRevision
      })
      if (
        !window.attn ||
        activeAccountRef.current !== account ||
        (targetSplitId !== undefined && activeSplitIdRef.current !== targetSplitId)
      ) {
        return null
      }
      const targetIndex = page.rows.findIndex((row) => row.id === threadId)
      // Direct focus requests should survive background refresh churn, including
      // split bootstrap and notification-driven view switches that legitimately
      // advance the Inbox refresh version while this targeted read is in flight.
      setRealThreads((current) => reuseThreadRows(current, page.rows))
      setLoadedInboxSplitId(targetSplitId ?? null)
      setLoadedInboxSplitStale(inboxSplitChangeRef.current !== inboxChange)
      setThreadPagination((current) => ({
        ...current,
        inbox: { nextCursor: page.nextCursor, loadingMore: false }
      }))
      return targetIndex >= 0 ? targetIndex : null
    },
    []
  )

  const focusMailboxThread = useCallback(
    async (threadId: string, view: 'allMail' | 'spam' | 'trash'): Promise<number | null> => {
      const account = activeAccountRef.current
      if (!window.attn || !account) return null
      mailboxRefreshVersionRef.current[view] = (mailboxRefreshVersionRef.current[view] ?? 0) + 1
      const page = await listThreadSnapshot(view, loadedRowCountsRef.current[view] ?? 0, {
        targetThreadId: threadId
      })
      if (activeAccountRef.current !== account || activeViewRef.current !== view) return null
      const index = page.rows.findIndex((row) => row.id === threadId)
      if (index < 0) return null
      setMailboxRows((current) => ({ ...current, [view]: reuseThreadRows(current[view] ?? null, page.rows) }))
      setThreadPagination((current) => ({
        ...current,
        [view]: { nextCursor: page.nextCursor, loadingMore: false }
      }))
      return index
    },
    [activeViewRef]
  )

  return {
    sync,
    inboxBackfillReady,
    networkOnline,
    realThreads,
    setRealThreads,
    loadedInboxSplitId,
    loadedInboxSplitStale,
    activateInboxSplitCache,
    preloadInboxSplits,
    realSnoozedThreads,
    setRealSnoozedThreads,
    mailboxRows,
    setMailboxRows,
    refreshCachedThreadView,
    threadPagination,
    loadMoreThreads,
    focusInboxThread,
    focusMailboxThread,
    realDrafts,
    realOutbox,
    outboxFailure,
    outboxProgress,
    clearOutboxFailure,
    refreshDrafts,
    refreshMailRows,
    realMailboxCounts,
    labels,
    pendingActionCount,
    pausedActionCount,
    mailRevision,
    mailChangeSource,
    invalidateConversations,
    preserveSelectionOnRefreshRef,
    deferRefreshUntilRef
  }
}
