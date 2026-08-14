import type { EditorState, LexicalEditor } from 'lexical'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Draft, DraftSaveInput } from '../../../shared/drafts'
import { serializeEditorState } from './serialize'

const IDLE_SAVE_MS = 1_000
const MAX_CHECKPOINT_MS = 5_000
const MIRROR_IDLE_MS = 3_000

type MutableDraftFields = Pick<DraftSaveInput, 'to' | 'cc' | 'bcc' | 'subject'>

function toSaveInput(draft: Draft): DraftSaveInput {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...input } = draft
  return input
}

export interface ComposerDraftController {
  saveStatus: 'saved' | 'saving'
  updateFields: (patch: Partial<MutableDraftFields>) => void
  captureEditor: (editorState: EditorState, editor: LexicalEditor, tags: Set<string>) => void
  saveNow: () => Promise<void>
}

export function useComposerDraft(draft: Draft): ComposerDraftController {
  const draftRef = useRef<DraftSaveInput>(toSaveInput(draft))
  const editorRef = useRef<{ state: EditorState; editor: LexicalEditor } | null>(null)
  const dirtyRef = useRef(false)
  const idleTimerRef = useRef<number | null>(null)
  const maxTimerRef = useRef<number | null>(null)
  const mirrorTimerRef = useRef<number | null>(null)
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const commitRef = useRef<() => Promise<void>>(async () => {})
  const [saveStatus, setSaveStatus] = useState<'saved' | 'saving'>('saved')

  const clearTimers = useCallback(() => {
    if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current)
    if (maxTimerRef.current !== null) window.clearTimeout(maxTimerRef.current)
    idleTimerRef.current = null
    maxTimerRef.current = null
  }, [])

  const commit = useCallback(async () => {
    if (!dirtyRef.current || !window.attn) return saveChainRef.current
    dirtyRef.current = false
    clearTimers()
    const editor = editorRef.current
    if (editor) Object.assign(draftRef.current, serializeEditorState(editor.state, editor.editor))
    const snapshot = structuredClone(draftRef.current)
    setSaveStatus('saving')
    saveChainRef.current = saveChainRef.current
      .catch(() => {})
      .then(async () => {
        await window.attn?.draft.save(snapshot)
      })
      .finally(() => setSaveStatus('saved'))
    return saveChainRef.current
  }, [clearTimers])
  commitRef.current = commit

  const markDirty = useCallback(() => {
    dirtyRef.current = true
    if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current)
    idleTimerRef.current = window.setTimeout(() => void commitRef.current().catch(() => {}), IDLE_SAVE_MS)
    if (maxTimerRef.current === null) {
      maxTimerRef.current = window.setTimeout(
        () => void commitRef.current().catch(() => {}),
        MAX_CHECKPOINT_MS
      )
    }
    if (mirrorTimerRef.current !== null) window.clearTimeout(mirrorTimerRef.current)
    mirrorTimerRef.current = window.setTimeout(() => {
      mirrorTimerRef.current = null
      void commitRef
        .current()
        .then(() => window.attn?.draft.mirror(draft.id))
        .catch(() => {})
    }, MIRROR_IDLE_MS)
  }, [draft.id])

  const updateFields = useCallback(
    (patch: Partial<MutableDraftFields>) => {
      Object.assign(draftRef.current, patch)
      markDirty()
    },
    [markDirty]
  )

  const captureEditor = useCallback(
    (state: EditorState, editor: LexicalEditor, tags: Set<string>) => {
      editorRef.current = { state, editor }
      if (!tags.has('draft-initial')) markDirty()
    },
    [markDirty]
  )

  useEffect(
    () => () => {
      clearTimers()
      if (mirrorTimerRef.current !== null) window.clearTimeout(mirrorTimerRef.current)
    },
    [clearTimers]
  )

  const saveNow = useCallback(async () => {
    if (mirrorTimerRef.current !== null) window.clearTimeout(mirrorTimerRef.current)
    mirrorTimerRef.current = null
    await commit()
    await window.attn?.draft.mirror(draft.id)
  }, [commit, draft.id])

  return { saveStatus, updateFields, captureEditor, saveNow }
}
