import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Conversation } from '../../../shared/mail'

interface ConversationThread {
  id: string
}

export function useConversation<TConversation>(
  selected: ConversationThread | undefined,
  selectedIndex: number,
  threads: ConversationThread[],
  readerOpen: boolean,
  account: string | null,
  convert: (conversation: Conversation) => TConversation
): { conversation: TConversation | null; scrollRef: React.RefObject<HTMLDivElement | null> } {
  const [conversation, setConversation] = useState<TConversation | null>(null)
  const cache = useRef(new Map<string, TConversation>())
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const autoReadThreadRef = useRef<string | null>(null)

  useEffect(() => {
    void account
    cache.current.clear()
    setConversation(null)
  }, [account])

  useEffect(() => {
    if (!selected) {
      setConversation(null)
      return
    }
    const cached = cache.current.get(selected.id)
    if (cached) {
      setConversation(cached)
      return
    }
    if (!window.attn) return
    let cancelled = false
    window.attn.mail
      .getConversation(selected.id)
      .then((result) => {
        if (cancelled || !result) return
        const display = convert(result)
        cache.current.set(selected.id, display)
        setConversation(display)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [convert, selected])

  useEffect(() => {
    if (!window.attn) return
    for (const index of [selectedIndex - 1, selectedIndex + 1]) {
      const thread = threads[index]
      if (!thread || cache.current.has(thread.id)) continue
      window.attn.mail
        .getConversation(thread.id)
        .then((result) => {
          if (result) cache.current.set(thread.id, convert(result))
        })
        .catch(() => {})
    }
  }, [convert, selectedIndex, threads])

  useEffect(() => {
    if (!readerOpen) {
      autoReadThreadRef.current = null
      return
    }
    if (!selected || autoReadThreadRef.current === selected.id) return
    autoReadThreadRef.current = selected.id
    void window.attn?.mail.markReadOnOpen(selected.id).catch(() => {})
  }, [readerOpen, selected])

  // biome-ignore lint/correctness/useExhaustiveDependencies: selected id deliberately resets scroll
  useLayoutEffect(() => {
    if (!readerOpen) return
    const scroll = scrollRef.current
    if (!scroll) return
    scroll.scrollTop = 0
    scroll.scrollLeft = 0
    scroll.focus({ preventScroll: true })
  }, [readerOpen, selected?.id])

  return { conversation, scrollRef }
}
