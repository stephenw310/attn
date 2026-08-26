import { useCallback, useEffect, useRef, useState } from 'react'
import type { ThreadRow } from '../../../shared/mail'

export type ServerSearchPhase = 'idle' | 'waiting' | 'complete' | 'offline' | 'auth-required' | 'error'

interface ServerSearchState {
  phase: ServerSearchPhase
  rows: ThreadRow[]
  message: string | null
  quotaWaitMs: number
}

interface ServerSearch extends ServerSearchState {
  run: () => void
  updateRows: (updater: (rows: ThreadRow[]) => ThreadRow[]) => void
}

const INITIAL_STATE: ServerSearchState = {
  phase: 'idle',
  rows: [],
  message: null,
  quotaWaitMs: 0
}

/** Run explicit Gmail searches while ignoring responses for a superseded query or account. */
export function useServerSearch(
  open: boolean,
  query: string,
  account: string | null,
  mailRevision: number,
  online: boolean
): ServerSearch {
  const [state, setState] = useState<ServerSearchState>(INITIAL_STATE)
  const requestVersionRef = useRef(0)
  const requestPendingRef = useRef(false)

  // biome-ignore lint/correctness/useExhaustiveDependencies: each identity change supersedes the previous request
  useEffect(() => {
    requestVersionRef.current++
    requestPendingRef.current = false
    setState(INITIAL_STATE)
  }, [account, open, query])

  // biome-ignore lint/correctness/useExhaustiveDependencies: a mail mutation moves cached server rows into local results
  useEffect(() => {
    setState((current) =>
      current.phase === 'waiting' || current.phase === 'complete' ? current : INITIAL_STATE
    )
  }, [mailRevision])

  useEffect(() => {
    if (online) setState((current) => (current.phase === 'offline' ? INITIAL_STATE : current))
  }, [online])

  const run = useCallback((): void => {
    if (!open || !account || !query.trim() || !window.attn || requestPendingRef.current) return
    const version = ++requestVersionRef.current
    requestPendingRef.current = true
    setState({ phase: 'waiting', rows: [], message: null, quotaWaitMs: 0 })
    void window.attn.mail
      .searchAll(query)
      .then((response) => {
        if (requestVersionRef.current !== version) return
        requestPendingRef.current = false
        if (response.status === 'ok') {
          setState({
            phase: 'complete',
            rows: response.rows,
            message: null,
            quotaWaitMs: response.quotaWaitMs
          })
          return
        }
        setState({
          phase: response.status,
          rows: [],
          message: response.message,
          quotaWaitMs: 0
        })
      })
      .catch(() => {
        if (requestVersionRef.current !== version) return
        requestPendingRef.current = false
        setState({
          phase: 'error',
          rows: [],
          message: 'Gmail search could not be completed',
          quotaWaitMs: 0
        })
      })
  }, [account, open, query])

  const updateRows = useCallback((updater: (rows: ThreadRow[]) => ThreadRow[]): void => {
    setState((current) => {
      const rows = updater(current.rows)
      return rows === current.rows ? current : { ...current, rows }
    })
  }, [])

  return { ...state, run, updateRows }
}
