import { useEffect, useRef, useState } from 'react'
import type { Draft } from '../../../shared/drafts'
import type { MailLabel, SnoozedThreadRow, SyncState, ThreadRow } from '../../../shared/mail'
import { refreshedSelectionIndex } from '../selection'

interface MailDataState {
  sync: SyncState
  networkOnline: boolean
  realThreads: ThreadRow[] | null
  setRealThreads: React.Dispatch<React.SetStateAction<ThreadRow[] | null>>
  realSnoozedThreads: SnoozedThreadRow[] | null
  realDrafts: Draft[]
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
  activeViewRef: React.RefObject<'inbox' | 'snoozed' | 'drafts'>,
  selectedThreadIdRef: React.RefObject<string | null>,
  selectedDraftIdRef: React.RefObject<string | null>,
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>
): MailDataState {
  const [sync, setSync] = useState<SyncState>({ phase: 'idle' })
  const [networkOnline, setNetworkOnline] = useState(() => navigator.onLine)
  const [realThreads, setRealThreads] = useState<ThreadRow[] | null>(null)
  const [realSnoozedThreads, setRealSnoozedThreads] = useState<SnoozedThreadRow[] | null>(null)
  const [realDrafts, setRealDrafts] = useState<Draft[]>([])
  const [realUnreadTotal, setRealUnreadTotal] = useState<number | null>(null)
  const [labels, setLabels] = useState<MailLabel[]>([])
  const [pendingCount, setPendingCount] = useState(0)
  const [actionsAuthPaused, setActionsAuthPaused] = useState(false)
  const [mailRevision, setMailRevision] = useState(0)
  const preserveSelectionOnRefreshRef = useRef(true)
  const deferRefreshUntilRef = useRef(0)

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
        bridge.mail.listLabels(),
        bridge.mail.getUnreadCount(),
        bridge.mail.getActionQueueStatus()
      ])
        .then(([threads, snoozed, drafts, nextLabels, unread, actionStatus]) => {
          if (cancelled) return
          const visible =
            activeViewRef.current === 'inbox'
              ? threads
              : activeViewRef.current === 'snoozed'
                ? snoozed
                : drafts
          const selectedId =
            activeViewRef.current === 'drafts' ? selectedDraftIdRef.current : selectedThreadIdRef.current
          setSelectedIndex((current) =>
            refreshedSelectionIndex(visible, preserveSelection ? selectedId : null, current)
          )
          setRealThreads(threads)
          setRealSnoozedThreads(snoozed)
          setRealDrafts(drafts)
          setLabels(nextLabels)
          setRealUnreadTotal(unread)
          setPendingCount(actionStatus.pending)
          setActionsAuthPaused(actionStatus.authPaused)
        })
        .catch(() => {})
    }
    refresh()
    const offMail = bridge.mail.onChanged(() => {
      mailChangedPending = true
      refresh()
    })
    return () => {
      cancelled = true
      if (deferredRefreshTimer !== null) window.clearTimeout(deferredRefreshTimer)
      offMail()
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
