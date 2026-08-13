import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { type DisplayConversation, type DisplayThread, displayConversation } from '../mailDisplay'

interface UseConversationOptions {
  selected: DisplayThread | undefined
  selectedIndex: number
  threads: DisplayThread[]
  readerOpen: boolean
  account: string | null
  mailRevision: number
}

interface ConversationState {
  conversation: DisplayConversation | null
  scrollRef: React.RefObject<HTMLDivElement | null>
}

export function useConversation(options: UseConversationOptions): ConversationState {
  const { selected, selectedIndex, threads, readerOpen, account, mailRevision } = options
  const [conversation, setConversation] = useState<DisplayConversation | null>(null)
  const cache = useRef(new Map<string, DisplayConversation>())
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const autoReadThreadRef = useRef<string | null>(null)
  const accountRef = useRef(account)
  const revisionRef = useRef(mailRevision)
  const selectedId = selected?.id

  useEffect(() => {
    if (accountRef.current === account) return
    accountRef.current = account
    cache.current.clear()
    setConversation(null)
  }, [account])

  useEffect(() => {
    if (revisionRef.current === mailRevision) return
    revisionRef.current = mailRevision
    cache.current.clear()
  }, [mailRevision])

  useEffect(() => {
    if (!selectedId) {
      setConversation(null)
      return
    }
    setConversation((current) => (current?.threadId === selectedId ? current : null))
    const cached = cache.current.get(selectedId)
    if (cached) {
      setConversation(cached)
      return
    }
    if (!window.attn) return
    let cancelled = false
    const requestedRevision = mailRevision
    window.attn.mail
      .getConversation(selectedId)
      .then((result) => {
        if (cancelled || revisionRef.current !== requestedRevision || !result) return
        const display = displayConversation(result)
        cache.current.set(selectedId, display)
        setConversation(display)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [mailRevision, selectedId])

  useEffect(() => {
    if (!window.attn) return
    const requestedRevision = mailRevision
    for (const index of [selectedIndex - 1, selectedIndex + 1]) {
      const thread = threads[index]
      if (!thread || cache.current.has(thread.id)) continue
      window.attn.mail
        .getConversation(thread.id)
        .then((result) => {
          if (revisionRef.current === requestedRevision && result) {
            cache.current.set(thread.id, displayConversation(result))
          }
        })
        .catch(() => {})
    }
  }, [mailRevision, selectedIndex, threads])

  useEffect(() => {
    if (!readerOpen) {
      autoReadThreadRef.current = null
      return
    }
    if (!selectedId || conversation?.threadId !== selectedId || autoReadThreadRef.current === selectedId) {
      return
    }
    autoReadThreadRef.current = selectedId
    void window.attn?.mail.markReadOnOpen(selectedId).catch(() => {})
  }, [conversation?.threadId, readerOpen, selectedId])

  // biome-ignore lint/correctness/useExhaustiveDependencies: selected id deliberately resets scroll
  useLayoutEffect(() => {
    if (!readerOpen) return
    const scroll = scrollRef.current
    if (!scroll) return
    scroll.scrollTop = 0
    scroll.scrollLeft = 0
    scroll.focus({ preventScroll: true })
  }, [readerOpen, selectedId])

  return { conversation, scrollRef }
}
