import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { hydrationAttemptDecision } from '../bodyHydrationStatus'
import { type DisplayConversation, type DisplayThread, displayConversation } from '../mailDisplay'

interface UseConversationOptions {
  selected: DisplayThread | undefined
  selectedIndex: number
  threads: DisplayThread[]
  readerOpen: boolean
  online: boolean
  account: string | null
  mailRevision: number
}

interface ConversationState {
  conversation: DisplayConversation | null
  scrollRef: React.RefObject<HTMLDivElement | null>
}

export function useConversation(options: UseConversationOptions): ConversationState {
  const { selected, selectedIndex, threads, readerOpen, online, account, mailRevision } = options
  const [conversation, setConversation] = useState<DisplayConversation | null>(null)
  const cache = useRef(new Map<string, DisplayConversation>())
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const autoReadThreadRef = useRef<string | null>(null)
  const hydrationTargetRef = useRef<string | null>(null)
  const accountRef = useRef(account)
  const revisionRef = useRef(mailRevision)
  const selectedId = selected?.id

  useEffect(() => {
    if (!window.attn) return
    return window.attn.mail.onBodyHydrationFailed((failedAccount, threadId) => {
      if (accountRef.current !== failedAccount) return
      const cached = cache.current.get(threadId)
      if (cached) cache.current.set(threadId, { ...cached, bodyHydrationFailed: true })
      setConversation((current) =>
        current?.threadId === threadId ? { ...current, bodyHydrationFailed: true } : current
      )
    })
  }, [])

  useEffect(() => {
    if (accountRef.current === account) return
    accountRef.current = account
    hydrationTargetRef.current = null
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
      hydrationTargetRef.current = null
      setConversation(null)
      return
    }
    setConversation((current) => (current?.threadId === selectedId ? current : null))
    const hydrationDecision = hydrationAttemptDecision(hydrationTargetRef.current, {
      account,
      threadId: selectedId,
      readerOpen,
      online
    })
    hydrationTargetRef.current = hydrationDecision.nextTarget
    const { allowHydration } = hydrationDecision
    const cached = cache.current.get(selectedId)
    if (cached) {
      const shouldHydrate =
        allowHydration && cached.messages.some((message) => message.bodyState !== 'complete')
      const next =
        shouldHydrate && cached.bodyHydrationFailed ? { ...cached, bodyHydrationFailed: false } : cached
      if (next !== cached) cache.current.set(selectedId, next)
      setConversation(next)
      if (!shouldHydrate) return
    }
    if (!window.attn) return
    let cancelled = false
    const requestedRevision = mailRevision
    window.attn.mail
      .getConversation(selectedId, allowHydration)
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
  }, [account, mailRevision, online, readerOpen, selectedId])

  useEffect(() => {
    if (!window.attn) return
    let cancelled = false
    const requestedRevision = mailRevision
    for (const index of [selectedIndex - 1, selectedIndex + 1]) {
      const thread = threads[index]
      if (!thread || cache.current.has(thread.id)) continue
      window.attn.mail
        .getConversation(thread.id, false)
        .then((result) => {
          // The revision alone cannot catch a sign-out: it resets to 0, so a
          // preload issued at revision 0 would still look current afterwards.
          if (cancelled || revisionRef.current !== requestedRevision || !result) return
          cache.current.set(thread.id, displayConversation(result))
        })
        .catch(() => {})
    }
    return () => {
      cancelled = true
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

  // Effects clear stale cached data after a selection change, but that is one
  // render too late for the reader: never let the previous thread's subject or
  // body flash under the newly selected thread while its conversation loads.
  return {
    conversation: conversation?.threadId === selectedId ? conversation : null,
    scrollRef
  }
}
