import { useEffect, useRef, useState } from 'react'
import type { MailLabel, SnoozedThreadRow, SyncState, ThreadRow } from '../../../shared/mail'
import { refreshedSelectionIndex } from '../selection'

interface MailDataState {
  sync: SyncState
  networkOnline: boolean
  realThreads: ThreadRow[] | null
  setRealThreads: React.Dispatch<React.SetStateAction<ThreadRow[] | null>>
  realSnoozedThreads: SnoozedThreadRow[] | null
  realUnreadTotal: number | null
  labels: MailLabel[]
  pendingCount: number
  mailRevision: number
  preserveSelectionOnRefreshRef: React.RefObject<boolean>
  deferRefreshUntilRef: React.RefObject<number>
}

export function useMailData(
  activeAccount: string | null,
  activeViewRef: React.RefObject<'inbox' | 'snoozed'>,
  selectedThreadIdRef: React.RefObject<string | null>,
  setSelectedIndex: React.Dispatch<React.SetStateAction<number>>
): MailDataState {
  const [sync, setSync] = useState<SyncState>({ phase: 'idle' })
  const [networkOnline, setNetworkOnline] = useState(() => navigator.onLine)
  const [realThreads, setRealThreads] = useState<ThreadRow[] | null>(null)
  const [realSnoozedThreads, setRealSnoozedThreads] = useState<SnoozedThreadRow[] | null>(null)
  const [realUnreadTotal, setRealUnreadTotal] = useState<number | null>(null)
  const [labels, setLabels] = useState<MailLabel[]>([])
  const [pendingCount, setPendingCount] = useState(0)
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
    setRealUnreadTotal(null)
    setLabels([])
    setPendingCount(0)
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
        bridge.mail.listLabels(),
        bridge.mail.getUnreadCount(),
        bridge.mail.getPendingActionCount()
      ])
        .then(([threads, snoozed, nextLabels, unread, pending]) => {
          if (cancelled) return
          const visible = activeViewRef.current === 'inbox' ? threads : snoozed
          setSelectedIndex((current) =>
            refreshedSelectionIndex(visible, preserveSelection ? selectedThreadIdRef.current : null, current)
          )
          setRealThreads(threads)
          setRealSnoozedThreads(snoozed)
          setLabels(nextLabels)
          setRealUnreadTotal(unread)
          setPendingCount(pending)
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
  }, [activeAccount, activeViewRef, selectedThreadIdRef, setSelectedIndex])

  return {
    sync,
    networkOnline,
    realThreads,
    setRealThreads,
    realSnoozedThreads,
    realUnreadTotal,
    labels,
    pendingCount,
    mailRevision,
    preserveSelectionOnRefreshRef,
    deferRefreshUntilRef
  }
}
