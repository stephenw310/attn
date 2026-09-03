import type { EditorState, LexicalEditor } from 'lexical'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { Draft, DraftSaveInput } from '../../../shared/drafts'
import {
  IDLE_SAVE_MS,
  MAX_CHECKPOINT_MS,
  MIRROR_IDLE_MS,
  MIRROR_PAYLOAD_BYTES,
  MIRROR_PAYLOAD_IDLE_MS
} from '../../../shared/outboxTuning'
import { serializeEditorState } from './serialize'

type MutableDraftFields = Pick<DraftSaveInput, 'to' | 'cc' | 'bcc' | 'subject' | 'attachments' | 'followUpAt'>

function mirrorIdleMs(attachments: DraftSaveInput['attachments']): number {
  const bytes = (attachments ?? []).reduce((total, attachment) => total + attachment.sizeBytes, 0)
  return bytes > MIRROR_PAYLOAD_BYTES ? MIRROR_PAYLOAD_IDLE_MS : MIRROR_IDLE_MS
}

function toSaveInput(draft: Draft): DraftSaveInput {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...input } = draft
  return input
}

export interface ComposerDraftController {
  localRevision: number
  savedRevision: number
  saveStatus: 'saved' | 'unsaved' | 'saving' | 'error'
  updateFields: (patch: Partial<MutableDraftFields>) => void
  captureEditor: (editorState: EditorState, editor: LexicalEditor, tags: Set<string>) => void
  saveNow: () => Promise<void>
}

export function useComposerDraft(draft: Draft, prepareSnapshot: () => void): ComposerDraftController {
  const draftRef = useRef<DraftSaveInput>(toSaveInput(draft))
  const editorRef = useRef<{ state: EditorState; editor: LexicalEditor } | null>(null)
  const localRevisionRef = useRef(0)
  const savedRevisionRef = useRef(0)
  const idleTimerRef = useRef<number | null>(null)
  const maxTimerRef = useRef<number | null>(null)
  const mirrorTimerRef = useRef<number | null>(null)
  const commitPromiseRef = useRef<Promise<void> | null>(null)
  const commitRef = useRef<() => Promise<void>>(async () => {})
  const prepareSnapshotRef = useRef(prepareSnapshot)
  const mountedRef = useRef(true)
  const [saveStatus, setSaveStatus] = useState<'saved' | 'unsaved' | 'saving' | 'error'>('saved')
  prepareSnapshotRef.current = prepareSnapshot

  const clearTimers = useCallback(() => {
    if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current)
    if (maxTimerRef.current !== null) window.clearTimeout(maxTimerRef.current)
    idleTimerRef.current = null
    maxTimerRef.current = null
  }, [])

  const armSaveTimers = useCallback((resetIdle: boolean) => {
    if (!mountedRef.current) return
    if (resetIdle && idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current)
    if (idleTimerRef.current === null || resetIdle) {
      idleTimerRef.current = window.setTimeout(() => {
        idleTimerRef.current = null
        void commitRef.current().catch(() => {})
      }, IDLE_SAVE_MS)
    }
    if (maxTimerRef.current === null) {
      maxTimerRef.current = window.setTimeout(() => {
        maxTimerRef.current = null
        void commitRef.current().catch(() => {})
      }, MAX_CHECKPOINT_MS)
    }
  }, [])

  const commit = useCallback((): Promise<void> => {
    if (!mountedRef.current) return Promise.resolve()
    if (commitPromiseRef.current) {
      return commitPromiseRef.current.then(() => commitRef.current())
    }
    // Recipient text deliberately remains editable until a checkpoint. Promote
    // complete valid addresses before cloning the durable snapshot; invalid
    // partial text must not block the rest of the message from autosaving.
    prepareSnapshotRef.current()
    if (savedRevisionRef.current >= localRevisionRef.current || !window.attn) {
      return Promise.resolve()
    }

    clearTimers()
    const editor = editorRef.current
    // Read the editor at commit time instead of trusting the last OnChange
    // callback. Lexical may batch that callback behind a streamed AI chunk;
    // an immediate Esc/save must still include every character already shown.
    if (editor) {
      Object.assign(draftRef.current, serializeEditorState(editor.editor.getEditorState(), editor.editor))
    }
    const revision = localRevisionRef.current
    const snapshot = structuredClone(draftRef.current)
    setSaveStatus('saving')

    const attempt = window.attn.draft
      .save(snapshot)
      .then(() => {
        savedRevisionRef.current = Math.max(savedRevisionRef.current, revision)
        if (mountedRef.current) {
          setSaveStatus(savedRevisionRef.current >= localRevisionRef.current ? 'saved' : 'unsaved')
        }
      })
      .catch((error: unknown) => {
        // Keep the same revision dirty and restore both checkpoints. The caller
        // still receives the rejection, while background autosave retries it.
        if (mountedRef.current) {
          setSaveStatus('error')
          armSaveTimers(false)
        }
        throw error
      })
      .finally(() => {
        commitPromiseRef.current = null
      })
    commitPromiseRef.current = attempt
    return attempt
  }, [armSaveTimers, clearTimers])
  commitRef.current = commit

  const markDirty = useCallback(
    (mirrorDelayMs?: number) => {
      if (!mountedRef.current) return
      localRevisionRef.current++
      setSaveStatus('unsaved')
      armSaveTimers(true)
      if (mirrorTimerRef.current !== null) window.clearTimeout(mirrorTimerRef.current)
      mirrorTimerRef.current = window.setTimeout(() => {
        mirrorTimerRef.current = null
        void commitRef
          .current()
          .then(() => (mountedRef.current ? window.attn?.draft.mirror(draft.id) : undefined))
          .catch(() => {})
      }, mirrorDelayMs ?? mirrorIdleMs(draftRef.current.attachments))
    },
    [armSaveTimers, draft.id]
  )

  const updateFields = useCallback(
    (patch: Partial<MutableDraftFields>) => {
      Object.assign(draftRef.current, patch)
      markDirty(patch.attachments ? MIRROR_IDLE_MS : undefined)
    },
    [markDirty]
  )

  const captureEditor = useCallback(
    (state: EditorState, editor: LexicalEditor, tags: Set<string>) => {
      editorRef.current = { state, editor }
      if (tags.has('attn-initial-html') || tags.has('attn-inline-image-load')) return
      markDirty()
    },
    [markDirty]
  )

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimers()
      if (mirrorTimerRef.current !== null) window.clearTimeout(mirrorTimerRef.current)
    }
  }, [clearTimers])

  useEffect(() => {
    // Quit tears the renderer down without running React cleanup, and the idle
    // checkpoint can be a second behind the keyboard. `pagehide` is the last
    // event this frame is guaranteed to see, so the checkpoint is issued there.
    // It cannot be awaited — the save is IPC — but `before-quit` defers the
    // quit behind an async teardown, so an already-sent request can still land.
    const checkpoint = (): void => {
      void commitRef.current().catch(() => {})
    }
    window.addEventListener('pagehide', checkpoint)
    return () => window.removeEventListener('pagehide', checkpoint)
  }, [])

  const saveNow = useCallback(async () => {
    if (mirrorTimerRef.current !== null) window.clearTimeout(mirrorTimerRef.current)
    mirrorTimerRef.current = null
    await commit()
    if (mountedRef.current) await window.attn?.draft.mirror(draft.id)
  }, [commit, draft.id])

  return {
    localRevision: localRevisionRef.current,
    savedRevision: savedRevisionRef.current,
    saveStatus,
    updateFields,
    captureEditor,
    saveNow
  }
}
