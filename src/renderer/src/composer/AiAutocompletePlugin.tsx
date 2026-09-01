import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $addUpdateTag,
  $getSelection,
  $isRangeSelection,
  HISTORY_MERGE_TAG,
  HISTORY_PUSH_TAG,
  type LexicalEditor
} from 'lexical'
import { useCallback, useEffect, useRef, useState } from 'react'
import { type AiThreadMessage, AUTOCOMPLETE_MAX_SUBJECT_CHARS } from '../../../shared/ai'
import { AutocompleteController } from './autocompleteController'
import { $autocompleteExcerpt, $caretAnchor } from './autocompleteExcerpt'
import { recipientGreetingSuggestion } from './recipientGreeting'

// Composer autocomplete: a transient gray suggestion at the caret, rendered
// OUTSIDE the persisted Lexical document — it can never enter autosave,
// mirroring, copies, or a send until Tab accepts it as one undoable plain-text
// insertion. A deterministic recipient greeting can appear immediately and
// never reaches a provider; AI requests start only after a deliberate typing
// pause. The controller owns debounce/staleness and the main-process transport
// owns consent and rate limits. Tab and Esc act only while a preview is visible
// and focus is in this body editor — pickers, the palette, and dialogs keep
// their keys because focus (and therefore this plugin's guard) leaves with them.

/** Tags an acceptance insert so the trigger listener never re-requests. */
export const AUTOCOMPLETE_ACCEPT_TAG = 'attn-autocomplete-accept'

interface PreviewPlacement {
  text: string
  left: number
  top: number
  maxWidth: number
}

function previewTextWidth(container: HTMLElement, text: string): number {
  const probe = document.createElement('span')
  probe.className = 'pointer-events-none absolute invisible whitespace-pre text-[13px] leading-5'
  probe.textContent = text
  container.append(probe)
  const width = probe.getBoundingClientRect().width
  probe.remove()
  return width
}

function previewPlacement(editor: LexicalEditor, text: string): PreviewPlacement | null {
  const rootElement = editor.getRootElement()
  const container = rootElement?.parentElement
  const selection = window.getSelection()
  if (!rootElement || !container || !selection || selection.rangeCount === 0) return null
  let rect = selection.getRangeAt(0).getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) {
    const anchorNode = selection.anchorNode
    const element = anchorNode instanceof HTMLElement ? anchorNode : (anchorNode?.parentElement ?? null)
    if (!element) return null
    rect = element.getBoundingClientRect()
  }
  const containerRect = container.getBoundingClientRect()
  const rootRect = rootElement.getBoundingClientRect()
  const rootStyle = getComputedStyle(rootElement)
  const rootPaddingLeft = Number.parseFloat(rootStyle.paddingLeft) || 0
  const rootPaddingRight = Number.parseFloat(rootStyle.paddingRight) || 0
  const caretLeft = rect.right - containerRect.left + container.scrollLeft
  const remaining = containerRect.width - (rect.right - containerRect.left) - 28
  const textLeft = rootRect.left - containerRect.left + container.scrollLeft + rootPaddingLeft
  const textWidth = Math.max(rootRect.width - rootPaddingLeft - rootPaddingRight, 160)
  const caretIsPastLineStart = caretLeft - textLeft > 4
  const suggestionWidth = previewTextWidth(container, text)
  if (caretIsPastLineStart && (remaining < 160 || suggestionWidth > remaining)) {
    const lineHeight = Number.parseFloat(rootStyle.lineHeight) || 20
    return {
      text,
      left: textLeft,
      top: rect.top - containerRect.top + container.scrollTop + lineHeight,
      maxWidth: textWidth
    }
  }
  return {
    text,
    left: caretLeft,
    top: rect.top - containerRect.top + container.scrollTop,
    maxWidth: remaining
  }
}

export function AiAutocompletePlugin({
  subject,
  recipientName,
  getThreadContext
}: {
  subject: string
  recipientName: string | null
  getThreadContext?: () => AiThreadMessage[] | null
}): React.JSX.Element | null {
  const [editor] = useLexicalComposerContext()
  const [preview, setPreview] = useState<PreviewPlacement | null>(null)
  const typedRef = useRef(false)
  const subjectRef = useRef(subject)
  const recipientNameRef = useRef(recipientName)
  const getThreadContextRef = useRef(getThreadContext)
  getThreadContextRef.current = getThreadContext

  const controllerRef = useRef<AutocompleteController | null>(null)
  if (controllerRef.current === null) {
    controllerRef.current = new AutocompleteController({
      now: () => Date.now(),
      setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
      clearTimer: (handle) => window.clearTimeout(handle as number),
      isEnabled: async () => {
        const bridge = window.attn
        if (!bridge) return false
        const settings = await bridge.ai.getSettings()
        return settings.enabled && settings.autocompleteEnabled
      },
      buildExcerpt: () => {
        const rootElement = editor.getRootElement()
        if (!rootElement?.contains(document.activeElement) || editor.isComposing()) {
          return null
        }
        // T37 generation/refine suppresses autocomplete outright.
        if (rootElement.dataset.aiStreaming === 'true') return null
        return editor.getEditorState().read(() => $autocompleteExcerpt())
      },
      currentAnchor: () => editor.getEditorState().read(() => $caretAnchor()),
      request: (excerpt) => {
        const bridge = window.attn
        if (!bridge) return Promise.reject(new Error('bridge unavailable'))
        const thread = getThreadContextRef.current?.() ?? null
        const currentSubject = subjectRef.current.slice(0, AUTOCOMPLETE_MAX_SUBJECT_CHARS)
        return bridge.ai.generate({
          purpose: 'autocomplete',
          prefix: excerpt.prefix,
          suffix: excerpt.suffix,
          ...(currentSubject.trim().length > 0 ? { subject: currentSubject } : {}),
          ...(thread && thread.length > 0 ? { thread } : {})
        })
      },
      cancelRequest: (requestId) => void window.attn?.ai.cancel(requestId).catch(() => {}),
      showPreview: (text) => setPreview(previewPlacement(editor, text)),
      clearPreview: () => setPreview(null)
    })
  }
  const controller = controllerRef.current

  // Subject and primary-recipient edits change completion context. Discard
  // any request or preview built from their previous values.
  useEffect(() => {
    subjectRef.current = subject
    recipientNameRef.current = recipientName
    controller.noteInvalidated()
  }, [controller, recipientName, subject])

  const accept = useCallback(() => {
    const text = controller.takeAcceptedText()
    if (text === null) return false
    editor.update(() => {
      $addUpdateTag(HISTORY_PUSH_TAG)
      $addUpdateTag(AUTOCOMPLETE_ACCEPT_TAG)
      const selection = $getSelection()
      if ($isRangeSelection(selection) && selection.isCollapsed()) selection.insertText(text)
    })
    return true
  }, [controller, editor])
  const acceptRef = useRef(accept)
  acceptRef.current = accept

  // Stream events for the whole app arrive here; the controller keeps only
  // the ones belonging to its current request. Setup revives the controller:
  // StrictMode's dev-only setup–cleanup–setup cycle disposed it in the probe
  // cleanup, which left autocomplete permanently dead (PR #101 review).
  useEffect(() => {
    controller.revive()
    const unsubscribe = window.attn?.ai.onStreamEvent((event) => controller.handleStreamEvent(event))
    return () => {
      unsubscribe?.()
      controller.dispose()
    }
  }, [controller])

  // Deliberate typing marks the next content update as a trigger candidate.
  useEffect(() => {
    const rootElement = editor.getRootElement()
    if (!rootElement) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.ctrlKey || event.metaKey || event.altKey) return
      if (event.key.length === 1 || event.key === 'Backspace' || event.key === 'Delete') {
        typedRef.current = true
      }
    }
    rootElement.addEventListener('keydown', onKeyDown)
    const onFocusOut = (): void => controller.noteInvalidated()
    rootElement.addEventListener('focusout', onFocusOut)
    window.addEventListener('blur', onFocusOut)
    return () => {
      rootElement.removeEventListener('keydown', onKeyDown)
      rootElement.removeEventListener('focusout', onFocusOut)
      window.removeEventListener('blur', onFocusOut)
    }
  }, [controller, editor])

  // Content and caret changes drive the controller. Foreign updates —
  // undo/redo, snippet expansion, AI-draft chunks, our own acceptance —
  // invalidate instead of triggering.
  useEffect(
    () =>
      editor.registerUpdateListener(({ tags, dirtyElements, dirtyLeaves, editorState, prevEditorState }) => {
        const contentChanged = dirtyLeaves.size > 0 || dirtyElements.size > 0
        const foreign =
          tags.has(HISTORY_PUSH_TAG) ||
          tags.has(HISTORY_MERGE_TAG) ||
          tags.has('historic') ||
          tags.has(AUTOCOMPLETE_ACCEPT_TAG)
        if (contentChanged) {
          if (!foreign && typedRef.current && !editor.isComposing()) {
            typedRef.current = false
            const immediate = editorState.read(() => {
              const excerpt = $autocompleteExcerpt()
              if (!excerpt) return null
              const text = recipientGreetingSuggestion(
                excerpt.prefix,
                excerpt.suffix,
                recipientNameRef.current
              )
              return text ? { text, anchor: excerpt.anchor } : null
            })
            controller.noteTypingEdit(immediate)
          } else {
            typedRef.current = false
            controller.noteInvalidated()
          }
          return
        }
        const anchor = editorState.read(() => $caretAnchor())
        const previous = prevEditorState.read(() => $caretAnchor())
        if (anchor !== previous) controller.noteCaretMoved()
      }),
    [controller, editor]
  )

  // Tab accepts and Esc dismisses — only with a visible preview AND focus in
  // this body editor, checked before anything else sees the key. With no
  // preview the listener is a pass-through, so normal Tab/Esc behavior and
  // every picker's key ownership stay intact.
  useEffect(() => {
    if (preview === null) return
    const onKeyDown = (event: KeyboardEvent): void => {
      const rootElement = editor.getRootElement()
      if (!rootElement?.contains(document.activeElement)) return
      if (event.key === 'Tab' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault()
        event.stopPropagation()
        acceptRef.current()
      } else if (event.key === 'Escape') {
        if (controller.dismiss()) {
          event.preventDefault()
          event.stopPropagation()
        }
      }
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [controller, editor, preview])

  if (preview === null) return null
  return (
    <>
      <span
        data-testid="ai-autocomplete-preview"
        aria-hidden
        className="pointer-events-none absolute z-10 whitespace-pre-wrap text-[13px] leading-5 text-ink-faint select-none"
        style={{ left: preview.left, top: preview.top, maxWidth: preview.maxWidth }}
      >
        {preview.text}
      </span>
      <span className="sr-only" role="status">
        Suggestion available — Tab accepts, Esc dismisses
      </span>
    </>
  )
}
