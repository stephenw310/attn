import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  IMPORTANT_SPLIT_ID,
  type ReorderSplitsInput,
  type SaveSplitInput,
  type SplitPresetId,
  type SplitState
} from '../../../shared/splits'

export interface SplitData {
  state: SplitState | null
  activeSplitId: string | null
  setActiveSplitId: (id: string) => void
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

export function useSplits(account: string | null, initialSplitId: string | null = null): SplitData {
  const [state, setState] = useState<SplitState | null>(null)
  const [activeSplitId, setActiveSplitIdState] = useState<string | null>(null)
  const activeSplitIdRef = useRef(activeSplitId)
  activeSplitIdRef.current = activeSplitId
  // A cross-account restore seeds the last active split. It participates only
  // while nothing newer chose a split, and `applyState` validates it against
  // the loaded rules — a since-deleted split falls back to the default (F18).
  const initialSplitIdRef = useRef(initialSplitId)
  const requestRef = useRef(0)
  const appliedRevisionRef = useRef(-1)

  const applyState = useCallback((next: SplitState): void => {
    if (next.revision < appliedRevisionRef.current) return
    appliedRevisionRef.current = next.revision
    setState(next)
    setActiveSplitIdState((current) => {
      const candidate = current ?? activeSplitIdRef.current ?? initialSplitIdRef.current
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
    appliedRevisionRef.current = -1
    setState(null)
    setActiveSplitIdState(null)
    if (!window.attn || !account) return
    void refresh().catch(() => {})
    return window.attn.mail.onChanged(() => {
      void refresh().catch(() => {})
    })
  }, [account, refresh])

  const setActiveSplitId = useCallback((id: string): void => {
    // Notification focus selects a split and immediately performs a targeted
    // read. Keep the validation ref in step with that imperative choice instead
    // of waiting for React's next render, which can otherwise reject the read.
    activeSplitIdRef.current = id
    setActiveSplitIdState(id)
  }, [])

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

  // Inbox threads this object through `switchSplit` into the ~60-command batch
  // `useInboxCommands` registers, so a fresh literal per render would unregister
  // and re-register the whole batch (and notify every registry subscriber).
  return useMemo(
    () => ({
      state,
      activeSplitId,
      setActiveSplitId,
      save,
      setNotify,
      remove,
      reorder,
      restorePreset
    }),
    [activeSplitId, remove, reorder, restorePreset, save, setActiveSplitId, setNotify, state]
  )
}
