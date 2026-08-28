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
import { reuseLabels, reuseSnoozedRows, reuseThreadRows } from '../mailDataEquality'
import {
  type CachedThreadView,
  cachedThreadView,
  labelMailboxView,
  type MailView,
  type PagedThreadView,
  userLabelId
} from '../mailDisplay'
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
  realDrafts: Draft[]
  realOutbox: OutboxItem[]
  outboxFailure: Extract<OutboxChanged, { kind: 'failed' }> | null
  outboxProgress: OutboxProgress | null
  clearOutboxFailure: () => void
  refreshDrafts: () => Promise<void>
  refreshMailRows: () => Promise<void>
  realMailboxCounts: SystemMailboxCounts | null
  realUnreadTotal: number | null
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
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>
): MailDataState {
  const [sync, setSync] = useState<SyncState>({ phase: 'idle' })
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
  const [realUnreadTotal, setRealUnreadTotal] = useState<number | null>(null)
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
  const effectAccountRef = useRef<string | null | undefined>(undefined)
  const effectSplitRevisionRef = useRef<number | null | undefined>(undefined)
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

  useEffect(() => {
    const accountChanged = effectAccountRef.current !== activeAccount
    const revisionChanged = effectSplitRevisionRef.current !== splitRevisionValue
    effectAccountRef.current = activeAccount
    effectSplitRevisionRef.current = splitRevisionValue
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
      setRealUnreadTotal(null)
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
    const bridge = window.attn
    if (!bridge || !activeAccount) return
    let cancelled = false
    let deferredRefreshTimer: number | null = null
    let mailChangedPending = false
    let pendingMailChangeSource: string | null | undefined
    let refreshInFlight = false
    let refreshQueued = false
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
      // Past the defer gate, so conversation caches age out with the thread list
      // rather than once per raw event: a burst during backfill, or an archive
      // animation holding the refresh, invalidates once instead of per event.
      if (mailChangedPending) {
        mailChangedPending = false
        setMailChangeSource(pendingMailChangeSource ?? null)
        pendingMailChangeSource = undefined
        setMailRevision((revision) => revision + 1)
      }
      const preserveSelection = preserveSelectionOnRefreshRef.current
      preserveSelectionOnRefreshRef.current = true
      const viewAtStart = activeViewRef.current
      const extraView = cachedThreadView(viewAtStart)
      const inboxSplitId = activeSplitId ?? null
      const inboxChange = inboxSplitChangeRef.current
      const inboxVersion = (mailboxRefreshVersionRef.current.inbox ?? 0) + 1
      const snoozedVersion = (mailboxRefreshVersionRef.current.snoozed ?? 0) + 1
      const extraViewVersion = extraView ? (mailboxRefreshVersionRef.current[extraView] ?? 0) + 1 : null
      mailboxRefreshVersionRef.current.inbox = inboxVersion
      mailboxRefreshVersionRef.current.snoozed = snoozedVersion
      if (extraView && extraViewVersion !== null) {
        mailboxRefreshVersionRef.current[extraView] = extraViewVersion
      }
      void Promise.all([
        listThreadSnapshot('inbox', loadedRowCountsRef.current.inbox ?? 0, {
          splitId: activeSplitId ?? undefined,
          expectedSplitRevision: splitRevisionValue ?? undefined
        }),
        listThreadSnapshot('snoozed', loadedRowCountsRef.current.snoozed ?? 0),
        bridge.draft.list(),
        bridge.outbox.listPending(),
        bridge.mail.listLabels(),
        bridge.mail.getMailboxCounts(),
        bridge.mail.getUnreadCount(),
        bridge.mail.getPendingActionCount(),
        bridge.mail.getActionQueueStatus(),
        extraView
          ? listThreadSnapshot(extraView, loadedRowCountsRef.current[extraView] ?? 0)
          : Promise.resolve(null)
      ])
        .then(
          ([
            inboxPage,
            snoozedPage,
            drafts,
            outbox,
            nextLabels,
            mailboxCounts,
            unread,
            pending,
            actionStatus,
            extraPage
          ]) => {
            if (cancelled) return
            const viewStillCurrent = activeViewRef.current === viewAtStart
            const inboxStillCurrent = mailboxRefreshVersionRef.current.inbox === inboxVersion
            const snoozedStillCurrent = mailboxRefreshVersionRef.current.snoozed === snoozedVersion
            const extraViewStillCurrent =
              !extraView || mailboxRefreshVersionRef.current[extraView] === extraViewVersion
            if (viewStillCurrent && extraViewStillCurrent) {
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
              setRealSnoozedThreads((current) =>
                reuseSnoozedRows(current, snoozedPage.rows as SnoozedThreadRow[])
              )
            }
            if (viewStillCurrent && extraViewStillCurrent) {
              // Mail changed, so cached rows for the other label-driven views are
              // stale: keep only the view this refresh just re-read. A refresh
              // started for an older view must not erase rows fetched after a
              // mailbox switch.
              setMailboxRows((current) =>
                extraView && extraPage
                  ? { [extraView]: reuseThreadRows(current[extraView] ?? null, extraPage.rows) }
                  : {}
              )
            }
            setThreadPagination((current) => {
              const next: ThreadPagination = viewStillCurrent && extraViewStillCurrent ? {} : { ...current }
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
              current && outbox.some((item) => item.id === current.id && item.state === 'sending')
                ? current
                : null
            )
            setLabels((current) => reuseLabels(current, nextLabels))
            setRealMailboxCounts(mailboxCounts)
            setRealUnreadTotal(unread)
            setPendingActionCount(pending)
            setPausedActionCount(actionStatus.paused)
          }
        )
        .catch(() => {})
        .finally(() => {
          refreshInFlight = false
          if (!refreshQueued || cancelled) return
          refreshQueued = false
          refresh()
        })
    }
    refresh()
    const offMail = bridge.mail.onChanged((serverSearchRequestId) => {
      // Inactive split pages remain useful immediately after ordinary mail
      // writes. Keep them visible on the next switch, then re-read that split
      // through this effect so stale rows converge without a blank frame.
      inboxSplitChangeRef.current += 1
      for (const cached of inboxSplitCacheRef.current.values()) cached.stale = true
      if (activeSplitIdRef.current) setLoadedInboxSplitStale(true)
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
      pendingMailChangeSource = null
      mailChangedPending = true
      refresh()
    })
    const offProgress = bridge.outbox.onProgress(setOutboxProgress)
    return () => {
      cancelled = true
      if (deferredRefreshTimer !== null) window.clearTimeout(deferredRefreshTimer)
      offMail()
      offOutbox()
      offProgress()
    }
  }, [
    activeAccount,
    activeSplitId,
    splitRevisionValue,
    activeViewRef,
    selectedDraftIdRef,
    selectedThreadIdRef,
    setSelectedIndex
  ])

  // One shared wait behind the defer gate, mirroring the coalescing timer the
  // event-driven refresh above uses: N closes during one triage animation
  // resume as one burst instead of N independent query storms.
  const awaitRefreshGate = async (): Promise<void> => {
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
  }

  const refreshDrafts = async (): Promise<void> => {
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
  }

  const refreshMailRows = async (): Promise<void> => {
    const account = activeAccount
    if (!window.attn || !account) return
    await awaitRefreshGate()
    if (!window.attn || activeAccountRef.current !== account) return
    const viewAtStart = activeViewRef.current
    const extraView = cachedThreadView(viewAtStart)
    const inboxSplitId = activeSplitIdRef.current ?? null
    const inboxChange = inboxSplitChangeRef.current
    const inboxVersion = (mailboxRefreshVersionRef.current.inbox ?? 0) + 1
    const snoozedVersion = (mailboxRefreshVersionRef.current.snoozed ?? 0) + 1
    const extraViewVersion = extraView ? (mailboxRefreshVersionRef.current[extraView] ?? 0) + 1 : null
    mailboxRefreshVersionRef.current.inbox = inboxVersion
    mailboxRefreshVersionRef.current.snoozed = snoozedVersion
    if (extraView && extraViewVersion !== null) {
      mailboxRefreshVersionRef.current[extraView] = extraViewVersion
    }
    const [inboxPage, snoozedPage, drafts, mailboxCounts, extraPage] = await Promise.all([
      listThreadSnapshot('inbox', loadedRowCountsRef.current.inbox ?? 0, {
        splitId: activeSplitIdRef.current ?? undefined,
        expectedSplitRevision: splitRevisionRef.current ?? undefined
      }),
      listThreadSnapshot('snoozed', loadedRowCountsRef.current.snoozed ?? 0),
      window.attn.draft.list(),
      window.attn.mail.getMailboxCounts(),
      extraView
        ? listThreadSnapshot(extraView, loadedRowCountsRef.current[extraView] ?? 0)
        : Promise.resolve(null)
    ])
    if (activeAccountRef.current !== account) return
    const viewStillCurrent = activeViewRef.current === viewAtStart
    const inboxStillCurrent = mailboxRefreshVersionRef.current.inbox === inboxVersion
    const snoozedStillCurrent = mailboxRefreshVersionRef.current.snoozed === snoozedVersion
    const extraViewStillCurrent =
      !extraView || mailboxRefreshVersionRef.current[extraView] === extraViewVersion
    if (viewStillCurrent && extraViewStillCurrent) {
      const visible =
        viewAtStart === 'inbox'
          ? inboxPage.rows
          : viewAtStart === 'snoozed'
            ? snoozedPage.rows
            : extraView
              ? (extraPage?.rows ?? [])
              : drafts
      const selectedId =
        viewAtStart === 'drafts' || viewAtStart === 'outbox'
          ? selectedDraftIdRef.current
          : selectedThreadIdRef.current
      const preserveSelection = preserveSelectionOnRefreshRef.current
      preserveSelectionOnRefreshRef.current = true
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
    if (viewStillCurrent && extraViewStillCurrent && extraView && extraPage) {
      setMailboxRows((current) => ({
        ...current,
        [extraView]: reuseThreadRows(current[extraView] ?? null, extraPage.rows)
      }))
    }
    setThreadPagination((current) => {
      const next: ThreadPagination = { ...current }
      if (inboxStillCurrent) next.inbox = { nextCursor: inboxPage.nextCursor, loadingMore: false }
      if (snoozedStillCurrent) {
        next.snoozed = { nextCursor: snoozedPage.nextCursor, loadingMore: false }
      }
      if (viewStillCurrent && extraViewStillCurrent && extraView && extraPage) {
        next[extraView] = { nextCursor: extraPage.nextCursor, loadingMore: false }
      }
      return next
    })
    setRealDrafts(drafts)
    setRealMailboxCounts(mailboxCounts)
  }

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

  return {
    sync,
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
    realDrafts,
    realOutbox,
    outboxFailure,
    outboxProgress,
    clearOutboxFailure,
    refreshDrafts,
    refreshMailRows,
    realMailboxCounts,
    realUnreadTotal,
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
