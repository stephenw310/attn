import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Step a highlight by one, wrapping at both ends. An empty list stays at 0 —
 * the pickers all render "no matching options" rather than a dead cursor.
 */
export function wrappedIndex(index: number, delta: number, count: number): number {
  if (count <= 0) return 0
  return (index + delta + count) % count
}

export interface HighlightedOption {
  index: number
  /** Point at one option (a pointer move over a row). */
  setIndex: (index: number) => void
  /** Back to the first option — a new query starts at the top. */
  reset: () => void
  /** ArrowDown / ArrowUp, wrapping at both ends. */
  move: (delta: 1 | -1) => void
  /** The ref callback for one option, keyed by id so the highlight can scroll. */
  optionRef: (id: string) => (element: HTMLElement | null) => void
}

/**
 * The highlight the label and move pickers share: clamped to the visible
 * options as they filter, wrapped by the arrow keys, and scrolled into view by
 * id — the option list re-orders as the query narrows, so a numeric index
 * alone cannot say which element to reveal.
 */
export function useHighlightedOption(optionIds: readonly string[]): HighlightedOption {
  const [index, setIndex] = useState(0)
  const elements = useRef(new Map<string, HTMLElement>())
  const refCallbacks = useRef(new Map<string, (element: HTMLElement | null) => void>())
  const count = optionIds.length
  const highlightedId = optionIds[index]

  useEffect(() => {
    setIndex((current) => Math.min(current, Math.max(count - 1, 0)))
  }, [count])

  useEffect(() => {
    if (highlightedId) elements.current.get(highlightedId)?.scrollIntoView({ block: 'nearest' })
  }, [highlightedId])

  const move = useCallback(
    (delta: 1 | -1) => setIndex((current) => wrappedIndex(current, delta, optionIds.length)),
    [optionIds.length]
  )
  const reset = useCallback(() => setIndex(0), [])
  // One callback identity per id: an inline ref callback would detach and
  // re-attach every element on every render.
  const optionRef = useCallback((id: string) => {
    const existing = refCallbacks.current.get(id)
    if (existing) return existing
    const callback = (element: HTMLElement | null): void => {
      if (element) elements.current.set(id, element)
      else elements.current.delete(id)
    }
    refCallbacks.current.set(id, callback)
    return callback
  }, [])

  return { index, setIndex, reset, move, optionRef }
}
