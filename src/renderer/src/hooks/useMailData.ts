import { useCallback, useEffect, useRef, useState } from 'react'
import type { Draft } from '../../../shared/drafts'
import type { MailLabel, SnoozedThreadRow, SyncState, ThreadRow } from '../../../shared/mail'
import type { OutboxChanged, OutboxItem, OutboxProgress } from '../../../shared/outbox'
import { reuseLabels, reuseSnoozedRows, reuseThreadRows } from '../mailDataEquality'
import { type LabelMailboxView, labelMailboxView, type MailView } from '../mailDisplay'
import { refreshedSelectionIndex } from '../selection'

/** Cached rows per label-driven mailbox view, kept across pure view switches. */
export type MailboxRowCache = Partial<Record<LabelMailboxView, ThreadRow[]>>

interface MailDataState {
  sync: SyncState
  networkOnline: boolean
  realThreads: ThreadRow[] | null
  setRealThreads: React.Dispatch<React.SetStateAction<ThreadRow[] | null>>
  realSnoozedThreads: SnoozedThreadRow[] | null
  setRealSnoozedThreads: React.Dispatch<React.SetStateAction<SnoozedThreadRow[] | null>>
  mailboxRows: MailboxRowCache
  setMailboxRows: React.Dispatch<React.SetStateAction<MailboxRowCache>>
  refreshMailboxView: (view: LabelMailboxView) => Promise<void>
  realDrafts: Draft[]
  realOutbox: OutboxItem[]
  outboxFailure: Extract<OutboxChanged, { kind: 'failed' }> | null
  outboxProgress: OutboxProgress | null
  clearOutboxFailure: () => void
  refreshDrafts: () => Promise<void>
  refreshMailRows: () => Promise<void>
  realUnreadTotal: number | null
  labels: MailLabel[]
  pendingActionCount: number
  pausedActionCount: number
  mailRevision: number
  invalidateConversations: () => void
  preserveSelectionOnRefreshRef: React.RefObject<boolean>
  deferRefreshUntilRef: React.RefObject<number>
}

export function useMailData(
  activeAccount: string | null,
  activeViewRef: React.RefObject<MailView>,
  selectedThreadIdRef: React.RefObject<string | null>,
  selectedDraftIdRef: React.RefObject<string | null>,
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>
): MailDataState {
  const [sync, setSync] = useState<SyncState>({ phase: 'idle' })
  const [networkOnline, setNetworkOnline] = useState(() => navigator.onLine)
  const [realThreads, setRealThreads] = useState<ThreadRow[] | null>(null)
  const [realSnoozedThreads, setRealSnoozedThreads] = useState<SnoozedThreadRow[] | null>(null)
  const [mailboxRows, setMailboxRows] = useState<MailboxRowCache>({})
  const [realDrafts, setRealDrafts] = useState<Draft[]>([])
  const [realOutbox, setRealOutbox] = useState<OutboxItem[]>([])
  const [outboxFailure, setOutboxFailure] = useState<Extract<OutboxChanged, { kind: 'failed' }> | null>(null)
  const [outboxProgress, setOutboxProgress] = useState<OutboxProgress | null>(null)
  const [realUnreadTotal, setRealUnreadTotal] = useState<number | null>(null)
  const [labels, setLabels] = useState<MailLabel[]>([])
  const [pendingActionCount, setPendingActionCount] = useState(0)
  const [pausedActionCount, setPausedActionCount] = useState(0)
  const [mailRevision, setMailRevision] = useState(0)
  const invalidateConversations = useCallback(() => setMailRevision((revision) => revision + 1), [])
  const preserveSelectionOnRefreshRef = useRef(true)
  const deferRefreshUntilRef = useRef(0)
  const deferGateRef = useRef<Promise<void> | null>(null)
  const activeAccountRef = useRef(activeAccount)
  activeAccountRef.current = activeAccount
  const clearOutboxFailure = useCallback(() => setOutboxFailure(null), [])

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
    setRealThreads(null)
    setRealSnoozedThreads(null)
    setMailboxRows({})
    setRealDrafts([])
    setRealOutbox([])
    setOutboxFailure(null)
    setOutboxProgress(null)
    setRealUnreadTotal(null)
    setLabels([])
    setPendingActionCount(0)
    setPausedActionCount(0)
    setMailRevision(0)
    preserveSelectionOnRefreshRef.current = true
    const bridge = window.attn
    if (!bridge || !activeAccount) return
    let cancelled = false
    let deferredRefreshTimer: number | null = null
    let mailChangedPending = false
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
        setMailRevision((revision) => revision + 1)
      }
      const preserveSelection = preserveSelectionOnRefreshRef.current
      preserveSelectionOnRefreshRef.current = true
      const extraView = labelMailboxView(activeViewRef.current)
      void Promise.all([
        bridge.mail.listThreads('inbox'),
        bridge.mail.listSnoozed(),
        bridge.draft.list(),
        bridge.outbox.listPending(),
        bridge.mail.listLabels(),
        bridge.mail.getUnreadCount(),
        bridge.mail.getPendingActionCount(),
        bridge.mail.getActionQueueStatus(),
        extraView ? bridge.mail.listThreads(extraView) : Promise.resolve(null)
      ])
        .then(([threads, snoozed, drafts, outbox, nextLabels, unread, pending, actionStatus, extraRows]) => {
          if (cancelled) return
          const active = activeViewRef.current
          const visible =
            active === 'inbox'
              ? threads
              : active === 'snoozed'
                ? snoozed
                : active === 'drafts'
                  ? drafts
                  : active === 'outbox'
                    ? outbox
                    : (extraRows ?? [])
          const selectedId =
            active === 'drafts' || active === 'outbox'
              ? selectedDraftIdRef.current
              : selectedThreadIdRef.current
          setSelectedIndex((current) =>
            refreshedSelectionIndex(visible, preserveSelection ? selectedId : null, current)
          )
          setRealThreads((current) => reuseThreadRows(current, threads))
          setRealSnoozedThreads((current) => reuseSnoozedRows(current, snoozed))
          // Mail changed, so cached rows for the other label-driven views are
          // stale: keep only the view this refresh just re-read.
          setMailboxRows((current) =>
            extraView && extraRows
              ? { [extraView]: reuseThreadRows(current[extraView] ?? null, extraRows) }
              : {}
          )
          setRealDrafts(drafts)
          setRealOutbox(outbox)
          setOutboxProgress((current) =>
            current && outbox.some((item) => item.id === current.id && item.state === 'sending')
              ? current
              : null
          )
          setLabels((current) => reuseLabels(current, nextLabels))
          setRealUnreadTotal(unread)
          setPendingActionCount(pending)
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
    refresh()
    const offMail = bridge.mail.onChanged(() => {
      mailChangedPending = true
      refresh()
    })
    const offOutbox = bridge.outbox.onChanged((change) => {
      if (change.kind === 'failed') setOutboxFailure(change)
      // Reply/forward rows are projected into the open conversation while
      // queued, so outbox transitions invalidate that cache as well as lists.
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
  }, [activeAccount, activeViewRef, selectedDraftIdRef, selectedThreadIdRef, setSelectedIndex])

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
    const extraView = labelMailboxView(activeViewRef.current)
    const [threads, snoozed, drafts, extraRows] = await Promise.all([
      window.attn.mail.listThreads('inbox'),
      window.attn.mail.listSnoozed(),
      window.attn.draft.list(),
      extraView ? window.attn.mail.listThreads(extraView) : Promise.resolve(null)
    ])
    if (activeAccountRef.current !== account) return
    const active = activeViewRef.current
    const visible =
      active === 'inbox' ? threads : active === 'snoozed' ? snoozed : extraView ? (extraRows ?? []) : drafts
    const selectedId =
      active === 'drafts' || active === 'outbox' ? selectedDraftIdRef.current : selectedThreadIdRef.current
    const preserveSelection = preserveSelectionOnRefreshRef.current
    preserveSelectionOnRefreshRef.current = true
    setSelectedIndex((current) =>
      refreshedSelectionIndex(visible, preserveSelection ? selectedId : null, current)
    )
    setRealThreads((current) => reuseThreadRows(current, threads))
    setRealSnoozedThreads((current) => reuseSnoozedRows(current, snoozed))
    if (extraView && extraRows) {
      setMailboxRows((current) => ({
        ...current,
        [extraView]: reuseThreadRows(current[extraView] ?? null, extraRows)
      }))
    }
    setRealDrafts(drafts)
  }

  /**
   * Read one label-driven view's rows without touching the rest of the
   * snapshot. View switches call this so a first visit fills the cache and a
   * return revalidates it in the background while cached rows render. Stable
   * identity: view-switch callbacks depend on it, and losing stability would
   * resubscribe every effect built on top of switching.
   */
  const refreshMailboxView = useCallback(async (view: LabelMailboxView): Promise<void> => {
    const account = activeAccountRef.current
    if (!window.attn || !account) return
    const rows = await window.attn.mail.listThreads(view)
    if (!window.attn || activeAccountRef.current !== account) return
    setMailboxRows((current) => ({ ...current, [view]: reuseThreadRows(current[view] ?? null, rows) }))
  }, [])

  return {
    sync,
    networkOnline,
    realThreads,
    setRealThreads,
    realSnoozedThreads,
    setRealSnoozedThreads,
    mailboxRows,
    setMailboxRows,
    refreshMailboxView,
    realDrafts,
    realOutbox,
    outboxFailure,
    outboxProgress,
    clearOutboxFailure,
    refreshDrafts,
    refreshMailRows,
    realUnreadTotal,
    labels,
    pendingActionCount,
    pausedActionCount,
    mailRevision,
    invalidateConversations,
    preserveSelectionOnRefreshRef,
    deferRefreshUntilRef
  }
}
