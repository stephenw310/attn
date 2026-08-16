import { useCallback, useEffect, useRef, useState } from 'react'
import type { Draft } from '../../../shared/drafts'
import type { MailLabel, SnoozedThreadRow, SyncState, ThreadRow } from '../../../shared/mail'
import type { OutboxChanged, OutboxItem } from '../../../shared/outbox'
import { refreshedSelectionIndex } from '../selection'

interface MailDataState {
  sync: SyncState
  networkOnline: boolean
  realThreads: ThreadRow[] | null
  setRealThreads: React.Dispatch<React.SetStateAction<ThreadRow[] | null>>
  realSnoozedThreads: SnoozedThreadRow[] | null
  realDrafts: Draft[]
  realOutbox: OutboxItem[]
  outboxFailure: Extract<OutboxChanged, { kind: 'failed' }> | null
  clearOutboxFailure: () => void
  refreshDrafts: () => Promise<void>
  realUnreadTotal: number | null
  labels: MailLabel[]
  pendingCount: number
  actionsAuthPaused: boolean
  mailRevision: number
  preserveSelectionOnRefreshRef: React.RefObject<boolean>
  deferRefreshUntilRef: React.RefObject<number>
}

export function useMailData(
  activeAccount: string | null,
  activeViewRef: React.RefObject<'inbox' | 'snoozed' | 'drafts' | 'outbox'>,
  selectedThreadIdRef: React.RefObject<string | null>,
  selectedDraftIdRef: React.RefObject<string | null>,
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>
): MailDataState {
  const [sync, setSync] = useState<SyncState>({ phase: 'idle' })
  const [networkOnline, setNetworkOnline] = useState(() => navigator.onLine)
  const [realThreads, setRealThreads] = useState<ThreadRow[] | null>(null)
  const [realSnoozedThreads, setRealSnoozedThreads] = useState<SnoozedThreadRow[] | null>(null)
  const [realDrafts, setRealDrafts] = useState<Draft[]>([])
  const [realOutbox, setRealOutbox] = useState<OutboxItem[]>([])
  const [outboxFailure, setOutboxFailure] = useState<Extract<OutboxChanged, { kind: 'failed' }> | null>(null)
  const [realUnreadTotal, setRealUnreadTotal] = useState<number | null>(null)
  const [labels, setLabels] = useState<MailLabel[]>([])
  const [pendingCount, setPendingCount] = useState(0)
  const [actionsAuthPaused, setActionsAuthPaused] = useState(false)
  const [mailRevision, setMailRevision] = useState(0)
  const preserveSelectionOnRefreshRef = useRef(true)
  const deferRefreshUntilRef = useRef(0)
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
    setRealDrafts([])
    setRealOutbox([])
    setOutboxFailure(null)
    setRealUnreadTotal(null)
    setLabels([])
    setPendingCount(0)
    setActionsAuthPaused(false)
    setMailRevision(0)
    preserveSelectionOnRefreshRef.current = true
    const bridge = window.attn
    if (!bridge || !activeAccount) return
    let cancelled = false
    let deferredRefreshTimer: number | null = null
    let mailChangedPending = false
    const refresh = (): void => {
      const delay = deferRefreshUntilRef.current - Date.now()
      if (delay > 0) {
        if (deferredRefreshTimer !== null) window.clearTimeout(deferredRefreshTimer)
        deferredRefreshTimer = window.setTimeout(refresh, delay)
        return
      }
      // Past the defer gate, so conversation caches age out with the thread list
      // rather than once per raw event: a burst during backfill, or an archive
      // animation holding the refresh, invalidates once instead of per event.
      if (mailChangedPending) {
        mailChangedPending = false
        setMailRevision((revision) => revision + 1)
      }
      const preserveSelection = preserveSelectionOnRefreshRef.current
      preserveSelectionOnRefreshRef.current = true
      void Promise.all([
        bridge.mail.listThreads(),
        bridge.mail.listSnoozed(),
        bridge.draft.list(),
        bridge.outbox.listPending(),
        bridge.mail.listLabels(),
        bridge.mail.getUnreadCount(),
        bridge.mail.getPendingActionCount(),
        bridge.mail.getActionQueueStatus()
      ])
        .then(([threads, snoozed, drafts, outbox, nextLabels, unread, pending, actionStatus]) => {
          if (cancelled) return
          const visible =
            activeViewRef.current === 'inbox'
              ? threads
              : activeViewRef.current === 'snoozed'
                ? snoozed
                : activeViewRef.current === 'drafts'
                  ? drafts
                  : outbox
          const selectedId =
            activeViewRef.current === 'drafts' || activeViewRef.current === 'outbox'
              ? selectedDraftIdRef.current
              : selectedThreadIdRef.current
          setSelectedIndex((current) =>
            refreshedSelectionIndex(visible, preserveSelection ? selectedId : null, current)
          )
          setRealThreads(threads)
          setRealSnoozedThreads(snoozed)
          setRealDrafts(drafts)
          setRealOutbox(outbox)
          setLabels(nextLabels)
          setRealUnreadTotal(unread)
          setPendingCount(pending)
          setActionsAuthPaused(actionStatus.authPaused)
        })
        .catch(() => {})
    }
    refresh()
    const offMail = bridge.mail.onChanged(() => {
      mailChangedPending = true
      refresh()
    })
    const offOutbox = bridge.outbox.onChanged((change) => {
      if (change.kind === 'failed') setOutboxFailure(change)
      mailChangedPending = true
      refresh()
    })
    return () => {
      cancelled = true
      if (deferredRefreshTimer !== null) window.clearTimeout(deferredRefreshTimer)
      offMail()
      offOutbox()
    }
  }, [activeAccount, activeViewRef, selectedDraftIdRef, selectedThreadIdRef, setSelectedIndex])

  const refreshDrafts = async (): Promise<void> => {
    if (!window.attn || !activeAccount) return
    const drafts = await window.attn.draft.list()
    setRealDrafts(drafts)
  }

  return {
    sync,
    networkOnline,
    realThreads,
    setRealThreads,
    realSnoozedThreads,
    realDrafts,
    realOutbox,
    outboxFailure,
    clearOutboxFailure,
    refreshDrafts,
    realUnreadTotal,
    labels,
    pendingCount,
    actionsAuthPaused,
    mailRevision,
    preserveSelectionOnRefreshRef,
    deferRefreshUntilRef
  }
}
