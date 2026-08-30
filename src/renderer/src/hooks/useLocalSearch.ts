import { useCallback, useEffect, useRef, useState } from 'react'
import type { ThreadRow } from '../../../shared/mail'
import type { SearchResponse } from '../../../shared/searchQuery'
import { SEARCH_DEBOUNCE_MS } from '../tuning'

interface LocalSearchState {
  response: SearchResponse | null
  pending: boolean
  failed: boolean
  completedQuery: string | null
  updateRows: (updater: (rows: ThreadRow[]) => ThreadRow[]) => void
}

/** Debounce local search and prevent an older IPC response from replacing a newer query. */
export function useLocalSearch(
  open: boolean,
  query: string,
  account: string | null,
  mailRevision: number
): LocalSearchState {
  const [response, setResponse] = useState<SearchResponse | null>(null)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const [completedQuery, setCompletedQuery] = useState<string | null>(null)
  const requestVersionRef = useRef(0)
  const mailRevisionRef = useRef(mailRevision)
  mailRevisionRef.current = mailRevision
  const updateRows = useCallback((updater: (rows: ThreadRow[]) => ThreadRow[]): void => {
    setResponse((current) => {
      if (!current) return current
      const rows = updater(current.rows)
      return rows === current.rows ? current : { ...current, rows }
    })
  }, [])

  useEffect(() => {
    const version = ++requestVersionRef.current
    const requestedMailRevision = mailRevision
    if (!open || !account || !query.trim() || !window.attn) {
      setPending(false)
      setFailed(false)
      if (!open || !query.trim()) {
        setResponse(null)
        setCompletedQuery(null)
      }
      return
    }
    setPending(true)
    setFailed(false)
    const timer = window.setTimeout(() => {
      window.attn?.mail
        .search(query)
        .then((next) => {
          if (requestVersionRef.current !== version || mailRevisionRef.current !== requestedMailRevision) {
            return
          }
          setResponse(next)
          setCompletedQuery(query)
          setPending(false)
        })
        .catch(() => {
          if (requestVersionRef.current !== version) return
          setPending(false)
          setFailed(true)
        })
    }, SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(timer)
  }, [account, mailRevision, open, query])

  return { response, pending, failed, completedQuery, updateRows }
}
