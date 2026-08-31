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
// the whole draft (refine included, whose removal of the prior region rides
// the same entry as its first new chunk). Esc mid-stream cancels the request
// and keeps the partial text. Everything inserts above the Gmail signature
// and Attn footer, which generation, refine, and undo never touch. Streamed
// text enters as plain text nodes — never markup — so rule 3 holds by
// construction, and nothing here can send: output lands behind the normal
// send flow.

interface AiRun {
  requestId: string | null
  active: boolean
  /** True once the first chunk landed (the history entry exists). */
  started: boolean
  refine: boolean
  /** Prior AI region, removed inside the first new chunk's history entry. */
  removeKeys: string[]
  /** Top-level node keys of the streamed region, in document order. */
  keys: string[]
  tailKey: string | null
}

interface AiDraftPluginProps {
  kind: Draft['kind']
  /** Monotonic invocation counter from the Inbox-owned command. */
  request: number
  /**
   * Claims the pending invocation exactly once. A remounted composer seeing a
   * stale counter finds nothing to claim, so it can never self-start.
   */
  claim: () => boolean
  getThreadContext: () => AiThreadMessage[] | null
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

export function AiDraftPlugin({
  kind,
  request,
  claim,
  getThreadContext,
  onToast
}: AiDraftPluginProps): React.JSX.Element | null {
  const [editor] = useLexicalComposerContext()
  const [phase, setPhase] = useState<'idle' | 'streaming' | 'landed'>('idle')
  const [edited, setEdited] = useState(false)
  const [refineDismissed, setRefineDismissed] = useState(false)
  const [refineText, setRefineText] = useState('')
  const runRef = useRef<AiRun | null>(null)
  const landedTextRef = useRef('')
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const claimRef = useRef(claim)
  claimRef.current = claim
  const onToastRef = useRef(onToast)
  onToastRef.current = onToast
  const getThreadContextRef = useRef(getThreadContext)
  getThreadContextRef.current = getThreadContext

  const regionText = useCallback(
    (keys: readonly string[]): string =>
      editor
        .getEditorState()
        .read(() => keys.map((key) => $getNodeByKey(key)?.getTextContent() ?? '').join('\n')),
    [editor]
  )

  const appendChunk = useCallback(
    (text: string) => {
      editor.update(() => {
        const run = runRef.current
        if (!run?.active) return
        if (!run.started) {
          run.started = true
          $addUpdateTag(HISTORY_PUSH_TAG)
          for (const key of run.removeKeys) $getNodeByKey(key)?.remove()
          const boundary = $signatureBoundary()
          if (!run.refine) {
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
          const paragraph = $createParagraphNode()
          if (boundary) boundary.insertBefore(paragraph)
          else $getRoot().append(paragraph)
          run.keys = [paragraph.getKey()]
          run.tailKey = paragraph.getKey()
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
          }
          if (segment.length > 0 && tail !== null && $isElementNode(tail)) {
            tail.append($createTextNode(segment))
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
      landedTextRef.current = regionText(run.keys)
      editor.update(() => {
        $addUpdateTag(HISTORY_MERGE_TAG)
        const tail = run.tailKey === null ? null : $getNodeByKey(run.tailKey)
        if (tail !== null && $isElementNode(tail)) tail.selectEnd()
      })
      setPhase('landed')
    } else if (run.refine && run.removeKeys.length > 0) {
      // The refine failed before its first chunk: the prior draft is intact.
      run.keys = run.removeKeys
      landedTextRef.current = regionText(run.keys)
      setPhase('landed')
    } else {
      setPhase('idle')
    }
    setEdited(false)
    setRefineDismissed(false)
  }, [editor, regionText])

  const cancel = useCallback(() => {
    const requestId = runRef.current?.requestId
    if (typeof requestId === 'string') void window.attn?.ai.cancel(requestId).catch(() => {})
    finish()
  }, [finish])
  const cancelRef = useRef(cancel)
  cancelRef.current = cancel

  const start = useCallback(
    async (refineInstruction?: string) => {
      const bridge = window.attn
      if (!bridge || runRef.current?.active) return
      if (kind !== 'reply' && kind !== 'replyAll') {
        onToastRef.current('AI drafting writes replies — open it from a reply composer')
        return
      }
      let settings: Awaited<ReturnType<typeof bridge.ai.getSettings>>
      try {
        settings = await bridge.ai.getSettings()
      } catch {
        return
      }
      if (!settings.enabled) {
        onToastRef.current('Enable AI writing in Settings to draft replies')
        return
      }
      const thread = getThreadContextRef.current()
      if (!thread || thread.length === 0) {
        onToastRef.current('The conversation is still loading — try again in a moment')
        return
      }
      let styleExamples: string[] | undefined
      if (settings.voiceMatchingEnabled) {
        try {
          const examples = await bridge.ai.styleExamples()
          if (examples.length > 0) styleExamples = examples
        } catch {
          // Voice matching is best effort; the draft proceeds without it.
        }
      }
      const refine = refineInstruction !== undefined
      const run: AiRun = {
        requestId: null,
        active: true,
        started: false,
        refine,
        removeKeys: refine ? [...(runRef.current?.keys ?? [])] : [],
        keys: [],
        tailKey: null
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
          ...(styleExamples ? { styleExamples } : {})
        })
        run.requestId = result.requestId
        for (const event of pending.splice(0)) handle(event)
      } catch (error) {
        onToastRef.current(errorMessage(error))
        finish()
      }
    },
    [appendChunk, finish, kind]
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

  // Refine is offered only while the AI region is unedited — text the user
  // touched is theirs (F17).
  useEffect(() => {
    if (phase !== 'landed' || edited) return
    return editor.registerUpdateListener(() => {
      const keys = runRef.current?.keys ?? []
      if (regionText(keys) !== landedTextRef.current) setEdited(true)
    })
  }, [edited, editor, phase, regionText])

  // Unmount (draft closed, sent, or switched) cancels silently; late events
  // can never reach another draft because the subscription dies here too.
  useEffect(
    () => () => {
      unsubscribeRef.current?.()
      unsubscribeRef.current = null
      const run = runRef.current
      if (run?.active && typeof run.requestId === 'string') {
        void window.attn?.ai.cancel(run.requestId).catch(() => {})
        run.active = false
      }
    },
    []
  )

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
  if (phase !== 'landed' || edited || refineDismissed) return null
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
              setRefineDismissed(true)
              editor.focus()
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
            setRefineDismissed(true)
            editor.focus()
          }}
          className="cursor-pointer rounded-full px-2 py-0.5 text-[11px] text-ink-faint hover:bg-active hover:text-ink"
        >
          ✕
        </button>
      </div>
    </div>
  )
}
