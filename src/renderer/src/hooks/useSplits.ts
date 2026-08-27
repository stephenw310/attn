import { useCallback, useEffect, useRef, useState } from 'react'
import {
  IMPORTANT_SPLIT_ID,
  type ReorderSplitsInput,
  type SaveSplitInput,
  type SplitPresetId,
  type SplitState
} from '../../../shared/splits'

interface SplitData {
  state: SplitState | null
  activeSplitId: string | null
  setActiveSplitId: (id: string) => void
  moveActive: (direction: -1 | 1) => void
  save: (input: SaveSplitInput) => Promise<void>
  setNotify: (id: string, notify: boolean) => Promise<void>
  remove: (id: string) => Promise<void>
  reorder: (input: ReorderSplitsInput) => Promise<void>
  restorePreset: (id: SplitPresetId) => Promise<void>
}

function defaultActiveSplit(state: SplitState): string | null {
  return state.splits.find((split) => split.id === IMPORTANT_SPLIT_ID)?.id ?? state.splits[0]?.id ?? null
}

function splitBridge(): NonNullable<typeof window.attn>['splits'] {
  const bridge = window.attn
  if (!bridge) throw new Error('Attn bridge is unavailable')
  return bridge.splits
}

export function useSplits(account: string | null): SplitData {
  const [state, setState] = useState<SplitState | null>(null)
  const [activeSplitId, setActiveSplitIdState] = useState<string | null>(null)
  const activeSplitIdRef = useRef(activeSplitId)
  activeSplitIdRef.current = activeSplitId
  const requestRef = useRef(0)

  const applyState = useCallback((next: SplitState): void => {
    setState(next)
    setActiveSplitIdState((current) => {
      const candidate = current ?? activeSplitIdRef.current
      return candidate && next.splits.some((split) => split.id === candidate)
        ? candidate
        : defaultActiveSplit(next)
    })
  }, [])

  const refresh = useCallback(async (): Promise<void> => {
    const bridge = window.attn
    if (!bridge || !account) return
    const request = ++requestRef.current
    const next = await bridge.splits.getState()
    if (request === requestRef.current) applyState(next)
  }, [account, applyState])

  useEffect(() => {
    requestRef.current += 1
    setState(null)
    setActiveSplitIdState(null)
    if (!window.attn || !account) return
    void refresh().catch(() => {})
    return window.attn.mail.onChanged(() => {
      void refresh().catch(() => {})
    })
  }, [account, refresh])

  const setActiveSplitId = useCallback((id: string): void => setActiveSplitIdState(id), [])

  const moveActive = useCallback(
    (direction: -1 | 1): void => {
      if (!state || !activeSplitId) return
      const current = state.splits.findIndex((split) => split.id === activeSplitId)
      if (current < 0) return
      const next = Math.max(0, Math.min(state.splits.length - 1, current + direction))
      setActiveSplitIdState(state.splits[next].id)
    },
    [activeSplitId, state]
  )

  const mutate = useCallback(
    async (operation: () => Promise<SplitState>): Promise<void> => {
      const next = await operation()
      applyState(next)
    },
    [applyState]
  )

  const save = useCallback((input: SaveSplitInput) => mutate(() => splitBridge().save(input)), [mutate])
  const setNotify = useCallback(
    (id: string, notify: boolean) => mutate(() => splitBridge().setNotify(id, notify)),
    [mutate]
  )
  const remove = useCallback((id: string) => mutate(() => splitBridge().delete(id)), [mutate])
  const reorder = useCallback(
    (input: ReorderSplitsInput) => mutate(() => splitBridge().reorder(input)),
    [mutate]
  )
  const restorePreset = useCallback(
    (id: SplitPresetId) => mutate(() => splitBridge().restorePreset(id)),
    [mutate]
  )

  return {
    state,
    activeSplitId,
    setActiveSplitId,
    moveActive,
    save,
    setNotify,
    remove,
    reorder,
    restorePreset
  }
}
