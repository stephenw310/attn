import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $addUpdateTag,
  $createParagraphNode,
  $createTextNode,
  $getNodeByKey,
  $getRoot,
  $isDecoratorNode,
  $isElementNode,
  $isParagraphNode,
  $isTextNode,
  HISTORY_MERGE_TAG,
  HISTORY_PUSH_TAG,
  type LexicalNode
} from 'lexical'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { AiStreamEvent, AiThreadMessage } from '../../../shared/ai'
import type { Draft } from '../../../shared/drafts'
import { errorMessage } from '../../../shared/error'
import type { ShowToast } from '../hooks/useToast'
import { AttnFooterNode } from './nodes/AttnFooterNode'
import { GmailSignatureNode } from './nodes/GmailSignatureNode'
import { GmailSignaturePrefixNode } from './nodes/GmailSignaturePrefixNode'

// AI reply drafting inside the composer (T37, F17). Chunks stream into
// Lexical as ordinary editable text committed as ONE history entry — the
// first chunk pushes, every later change merges — so a single Mod+Z removes
// the whole draft or only the continuation appended after authored text.
// Esc mid-stream cancels the request and keeps the partial text. Everything
// inserts above the Gmail signature and Attn footer, which generation, refine,
// and undo never touch. Streamed text enters as plain text nodes — never
// markup — so rule 3 holds by construction, and nothing here can send: output
// lands behind the normal send flow.

interface AiRun {
  requestId: string | null
  active: boolean
  /** True once the first chunk landed (the history entry exists). */
  started: boolean
  refine: boolean
  /** Existing authored text that generation/refine must leave byte-for-byte intact. */
  authoredPrefix: string | undefined
  /** Last authored top-level element; continuations append here before adding paragraphs. */
  appendToKey: string | null
  /** Prior AI region, removed inside the first new chunk's history entry. */
  removeKeys: string[]
  /** Generated node keys; an inline first key may be a TextNode inside appendToKey. */
  keys: string[]
  /** Last top-level element receiving streamed text. */
  tailKey: string | null
  /** Generated TextNode receiving later chunks on the current line. */
  inlineTailKey: string | null
  /** Exact provider output, including a leading paragraph break. */
  streamedText: string
}

interface AiDraftPluginProps {
  kind: Draft['kind']
  threadId: Draft['threadId']
  /** Monotonic invocation counter from the Inbox-owned command. */
  request: number
  /**
   * Claims the pending invocation exactly once. A remounted composer seeing a
   * stale counter finds nothing to claim, so it can never self-start.
   */
  claim: () => boolean
  getThreadContext: () => AiThreadMessage[] | null
  /** Makes an immediately-following save observe the completed stream. */
  onContentSettled: () => void
  onToast: ShowToast
}

function $signatureBoundary(): LexicalNode | null {
  for (const child of $getRoot().getChildren()) {
    if (
      child instanceof GmailSignaturePrefixNode ||
      child instanceof GmailSignatureNode ||
      child instanceof AttnFooterNode
    ) {
      return child
    }
  }
  return null
}

function $isBlankParagraph(node: LexicalNode): boolean {
  return (
    $isParagraphNode(node) &&
    node.getTextContent().trim() === '' &&
    !node.getChildren().some((child) => $isDecoratorNode(child))
  )
}

interface AuthoredSnapshot {
  keys: string[]
  text: string
}

/** The replaceable reply region above the protected signature/footer boundary. */
function $authoredSnapshot(): AuthoredSnapshot {
  const keys: string[] = []
  const parts: string[] = []
  for (const child of $getRoot().getChildren()) {
    if (
      child instanceof GmailSignaturePrefixNode ||
      child instanceof GmailSignatureNode ||
      child instanceof AttnFooterNode
    ) {
      break
    }
    keys.push(child.getKey())
    parts.push(child.getTextContent())
  }
  const text = parts.join('\n')
  return { keys, text }
}

export function AiDraftPlugin({
  kind,
  threadId,
  request,
  claim,
  getThreadContext,
  onContentSettled,
  onToast
}: AiDraftPluginProps): React.JSX.Element | null {
  const [editor] = useLexicalComposerContext()
  const [phase, setPhase] = useState<'idle' | 'streaming' | 'landed'>('idle')
  const [edited, setEdited] = useState(false)
  const [refineDismissed, setRefineDismissed] = useState(false)
  const [refineText, setRefineText] = useState('')
  const runRef = useRef<AiRun | null>(null)
  /** Set on unmount so the awaits inside a preparing start() stop cold. */
  const disposedRef = useRef(false)
  /** One preparation at a time: a second invocation mid-await must not start a second request. */
  const preparingRef = useRef(false)
  const landedTextRef = useRef('')
  const landedAuthoredTextRef = useRef('')
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const claimRef = useRef(claim)
  claimRef.current = claim
  const onToastRef = useRef(onToast)
  onToastRef.current = onToast
  const getThreadContextRef = useRef(getThreadContext)
  getThreadContextRef.current = getThreadContext
  const onContentSettledRef = useRef(onContentSettled)
  onContentSettledRef.current = onContentSettled

  const appendChunk = useCallback(
    (text: string) => {
      editor.update(() => {
        const run = runRef.current
        if (!run?.active) return
        run.streamedText += text
        if (!run.started) {
          run.started = true
          $addUpdateTag(HISTORY_PUSH_TAG)
          for (const key of run.removeKeys) $getNodeByKey(key)?.remove()
          const boundary = $signatureBoundary()
          let tail = run.appendToKey === null ? null : $getNodeByKey(run.appendToKey)
          if (tail !== null && !$isElementNode(tail)) tail = null
          if (!run.refine && tail === null) {
            // A fresh reply's lead-in is usually one empty paragraph; clear a
            // fully blank authored region so the draft starts at the top, but
            // never touch real user content above the signature.
            const lead: LexicalNode[] = []
            for (const child of $getRoot().getChildren()) {
              if (boundary !== null && child.getKey() === boundary.getKey()) break
              lead.push(child)
            }
            if (lead.length > 0 && lead.every($isBlankParagraph)) {
              for (const node of lead) node.remove()
            }
          }
          if (tail === null) {
            const paragraph = $createParagraphNode()
            if (boundary) boundary.insertBefore(paragraph)
            else $getRoot().append(paragraph)
            run.keys = [paragraph.getKey()]
            run.tailKey = paragraph.getKey()
          } else {
            run.tailKey = tail.getKey()
          }
        } else {
          $addUpdateTag(HISTORY_MERGE_TAG)
        }
        let tail = run.tailKey === null ? null : $getNodeByKey(run.tailKey)
        if (tail === null) return
        const segments = text.split('\n')
        segments.forEach((segment, index) => {
          if (index > 0 && tail !== null) {
            const paragraph = $createParagraphNode()
            tail.insertAfter(paragraph)
            tail = paragraph
            run.keys.push(paragraph.getKey())
            run.tailKey = paragraph.getKey()
            run.inlineTailKey = null
          }
          if (segment.length > 0 && tail !== null && $isElementNode(tail)) {
            const inlineTail = run.inlineTailKey === null ? null : $getNodeByKey(run.inlineTailKey)
            if ($isTextNode(inlineTail) && inlineTail.getParent()?.getKey() === tail.getKey()) {
              inlineTail.setTextContent(inlineTail.getTextContent() + segment)
            } else {
              const generated = $createTextNode(segment)
              if (tail.getKey() === run.appendToKey) {
                // Keep the generated continuation separately addressable for
                // refine without making it a token or otherwise restricting edits.
                generated.toggleUnmergeable()
                run.keys.push(generated.getKey())
              }
              tail.append(generated)
              run.inlineTailKey = generated.getKey()
            }
          }
        })
      })
    },
    [editor]
  )

  /** End the stream (done, error, cancel, unmount) and settle the region. */
  const finish = useCallback(() => {
    const run = runRef.current
    if (!run?.active) return
    run.active = false
    unsubscribeRef.current?.()
    unsubscribeRef.current = null
    if (run.started) {
      landedTextRef.current = run.streamedText
      landedAuthoredTextRef.current = editor.getEditorState().read(() => $authoredSnapshot().text)
      editor.update(() => {
        $addUpdateTag(HISTORY_MERGE_TAG)
        const tail = run.tailKey === null ? null : $getNodeByKey(run.tailKey)
        if (tail !== null && $isElementNode(tail)) tail.selectEnd()
      })
      setPhase('landed')
      onContentSettledRef.current()
    } else if (run.refine && run.removeKeys.length > 0) {
      // The refine failed before its first chunk: the prior draft is intact.
      run.keys = run.removeKeys
      setPhase('landed')
    } else {
      setPhase('idle')
    }
    setEdited(false)
    setRefineDismissed(false)
  }, [editor])

  const cancel = useCallback(() => {
    const requestId = runRef.current?.requestId
    if (typeof requestId === 'string') void window.attn?.ai.cancel(requestId).catch(() => {})
    finish()
  }, [finish])
  const cancelRef = useRef(cancel)
  cancelRef.current = cancel

  const startPrepared = useCallback(
    async (bridge: NonNullable<typeof window.attn>, refineInstruction?: string) => {
      // Capture the conversation before any await: once this turn yields, the
      // composer can close and another conversation can open, and a later read
      // would draft against the newly selected thread (PR #101 review).
      const thread = getThreadContextRef.current()
      const authoredBeforePrepare = editor.getEditorState().read(() => $authoredSnapshot())
      let settings: Awaited<ReturnType<typeof bridge.ai.getSettings>>
      try {
        settings = await bridge.ai.getSettings()
      } catch {
        return
      }
      if (disposedRef.current) return
      if (!settings.enabled) {
        onToastRef.current('Enable AI writing in Settings to draft replies')
        return
      }
      if (!thread || thread.length === 0) {
        onToastRef.current('The conversation is still loading — try again in a moment')
        return
      }
      let styleExamples: string[] | undefined
      if (settings.voiceMatchingEnabled && threadId !== null) {
        try {
          const examples = await bridge.ai.styleExamples(threadId)
          if (examples.length > 0) styleExamples = examples
        } catch {
          // Voice matching is best effort; the draft proceeds without it.
        }
        if (disposedRef.current) return
      }
      const authored = editor.getEditorState().read(() => $authoredSnapshot())
      if (authored.text !== authoredBeforePrepare.text) {
        onToastRef.current('The draft changed while AI was preparing — run it again')
        return
      }
      const refine = refineInstruction !== undefined
      const priorRun = runRef.current
      const existingDraft = refine
        ? priorRun?.authoredPrefix
        : authored.text.trim().length > 0
          ? authored.text
          : undefined
      const run: AiRun = {
        requestId: null,
        active: true,
        started: false,
        refine,
        authoredPrefix: existingDraft,
        appendToKey: refine
          ? (priorRun?.appendToKey ?? null)
          : existingDraft
            ? (authored.keys.at(-1) ?? null)
            : null,
        removeKeys: refine ? [...(priorRun?.keys ?? [])] : [],
        keys: [],
        tailKey: null,
        inlineTailKey: null,
        streamedText: ''
      }
      const priorDraft = refine ? landedTextRef.current : undefined
      runRef.current = run
      setPhase('streaming')
      setEdited(false)
      setRefineDismissed(false)
      setRefineText('')
      // Subscribe before generating; events that beat the id round trip wait.
      const pending: AiStreamEvent[] = []
      const handle = (event: AiStreamEvent): void => {
        if (!run.active || event.requestId !== run.requestId) return
        if (event.kind === 'chunk') appendChunk(event.text)
        else if (event.kind === 'done') finish()
        else {
          onToastRef.current(event.message)
          finish()
        }
      }
      const route = (event: AiStreamEvent): void => {
        if (run.requestId === null) pending.push(event)
        else handle(event)
      }
      unsubscribeRef.current?.()
      unsubscribeRef.current = bridge.ai.onStreamEvent(route)
      try {
        const result = await bridge.ai.generate({
          purpose: refine ? 'refine' : 'reply',
          thread,
          ...(refine ? { instruction: refineInstruction, priorDraft } : {}),
          ...(existingDraft ? { existingDraft } : {}),
          ...(styleExamples ? { styleExamples } : {})
        })
        // The unmount cleanup could not cancel a request whose id was still in
        // flight; a generation landing on a disposed plugin is canceled here.
        if (!run.active) {
          void bridge.ai.cancel(result.requestId).catch(() => {})
          return
        }
        run.requestId = result.requestId
        for (const event of pending.splice(0)) handle(event)
      } catch (error) {
        if (disposedRef.current) return
        onToastRef.current(errorMessage(error))
        finish()
      }
    },
    [appendChunk, editor, finish, threadId]
  )

  const start = useCallback(
    async (refineInstruction?: string) => {
      const bridge = window.attn
      // The preparing flag closes startPrepared's awaits to a second
      // invocation: without it, two rapid commands both reached generate and
      // Esc could cancel only the later request (PR #101 review).
      if (!bridge || runRef.current?.active || preparingRef.current) return
      if (kind !== 'reply' && kind !== 'replyAll') {
        onToastRef.current('AI drafting writes replies — open it from a reply composer')
        return
      }
      preparingRef.current = true
      try {
        await startPrepared(bridge, refineInstruction)
      } finally {
        preparingRef.current = false
      }
    },
    [kind, startPrepared]
  )
  const startRef = useRef(start)
  startRef.current = start

  // The Inbox-owned command bumps the counter; each bump is one invocation,
  // claimed here whether the composer was already open or opened for it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each counter bump re-runs the claim
  useEffect(() => {
    if (!claimRef.current()) return
    if (!runRef.current?.active) void startRef.current()
  }, [request])

  // T37A reads this flag to suppress autocomplete during generation/refine.
  useEffect(() => {
    const rootElement = editor.getRootElement()
    if (!rootElement) return
    if (phase === 'streaming') rootElement.dataset.aiStreaming = 'true'
    else delete rootElement.dataset.aiStreaming
    return () => {
      delete rootElement.dataset.aiStreaming
    }
  }, [editor, phase])

  // Esc during streaming cancels the request and keeps the partial text; the
  // capture phase claims the key before the composer's own close handling.
  useEffect(() => {
    if (phase !== 'streaming') return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
      event.preventDefault()
      event.stopPropagation()
      cancelRef.current()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [phase])

  const showRefine = phase === 'landed' && !edited && !refineDismissed
  const dismissRefine = useCallback(() => {
    setRefineDismissed(true)
    editor.focus()
  }, [editor])

  // A landed draft leaves focus in the body, not in the pill. Claim the
  // first unmodified Esc from either surface so it dismisses Refine; only the
  // next Esc reaches the composer's save-and-close command.
  useEffect(() => {
    if (!showRefine) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
        return
      }
      const root = editor.getRootElement()
      const target = event.target as Element | null
      if (!root?.contains(document.activeElement) && !target?.closest('[data-testid="ai-refine"]')) {
        return
      }
      event.preventDefault()
      event.stopPropagation()
      dismissRefine()
    }
    document.addEventListener('keydown', onKeyDown, true)
    return () => document.removeEventListener('keydown', onKeyDown, true)
  }, [dismissRefine, editor, showRefine])

  // Refine is offered only while the authored region is unchanged — text the
  // user touched after generation is theirs (F17).
  useEffect(() => {
    if (phase !== 'landed' || edited) return
    return editor.registerUpdateListener(({ editorState }) => {
      const authoredText = editorState.read(() => $authoredSnapshot().text)
      if (authoredText !== landedAuthoredTextRef.current) setEdited(true)
    })
  }, [edited, editor, phase])

  // Unmount (draft closed, sent, or switched) cancels silently; late events
  // can never reach another draft because the subscription dies here too. A
  // run whose request id is still in flight is canceled by start() when the
  // id lands and finds the run deactivated. Setup clears the disposed flag:
  // StrictMode's dev-only setup–cleanup–setup cycle would otherwise leave the
  // plugin permanently dead after its probe cleanup (PR #101 review).
  useEffect(() => {
    disposedRef.current = false
    return () => {
      disposedRef.current = true
      unsubscribeRef.current?.()
      unsubscribeRef.current = null
      const run = runRef.current
      if (run?.active) {
        if (typeof run.requestId === 'string') void window.attn?.ai.cancel(run.requestId).catch(() => {})
        run.active = false
      }
    }
  }, [])

  if (phase === 'streaming') {
    return (
      <div className="pointer-events-none absolute inset-x-0 bottom-2 z-20 flex justify-center">
        <span
          data-testid="ai-drafting"
          className="rounded-full border border-edge bg-raised px-3 py-1 text-[11px] text-ink-dim shadow-lg"
        >
          Drafting reply… <span className="text-ink-faint">Esc cancels</span>
        </span>
      </div>
    )
  }
  if (!showRefine) return null
  const runRefine = (): void => {
    const instruction = refineText.trim()
    if (instruction.length === 0) return
    void startRef.current(instruction)
  }
  return (
    <div className="absolute inset-x-0 bottom-2 z-20 flex justify-center" data-composer-transient>
      <div
        data-testid="ai-refine"
        className="flex w-full max-w-md items-center gap-1.5 rounded-full border border-edge bg-raised py-1 pr-1 pl-3 shadow-lg"
      >
        <input
          data-testid="ai-refine-input"
          aria-label="Refine the AI draft"
          placeholder="Refine: shorter, more formal…"
          value={refineText}
          onChange={(event) => setRefineText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              event.stopPropagation()
              runRefine()
            } else if (event.key === 'Escape') {
              event.preventDefault()
              event.stopPropagation()
              dismissRefine()
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-xs text-ink outline-none placeholder:text-ink-faint"
        />
        <button
          type="button"
          data-testid="ai-refine-run"
          disabled={refineText.trim().length === 0}
          onClick={runRefine}
          className="cursor-pointer rounded-full border border-edge px-2.5 py-0.5 text-[11px] text-ink-dim hover:bg-active hover:text-ink disabled:cursor-default disabled:opacity-45"
        >
          Refine
        </button>
        <button
          type="button"
          data-testid="ai-refine-close"
          aria-label="Dismiss refine"
          onClick={() => {
            dismissRefine()
          }}
          className="cursor-pointer rounded-full px-2 py-0.5 text-[11px] text-ink-faint hover:bg-active hover:text-ink"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
