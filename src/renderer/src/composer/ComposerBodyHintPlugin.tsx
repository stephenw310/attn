import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $getRoot,
  $getSelection,
  $isDecoratorNode,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  type LexicalNode
} from 'lexical'
import { useEffect, useState } from 'react'
import { Kbd } from '../components/Kbd'
import { modKeyLabel } from '../platform'
import { AI_DRAFT_HINT_IDLE_MS } from '../tuning'
import { $isProtectedComposerNode } from './nodes/protected'

function hasNonTextContent(node: LexicalNode): boolean {
  if ($isDecoratorNode(node)) return true
  return $isElementNode(node) && node.getChildren().some(hasNonTextContent)
}

/** Whether the editable body above its protected signature/footer has content. */
function $authoredBodyIsEmpty(): boolean {
  for (const child of $getRoot().getChildren()) {
    if ($isProtectedComposerNode(child)) continue
    if (child.getTextContent().trim().length > 0 || hasNonTextContent(child)) return false
  }
  return true
}

/** A collapsed caret at the end of an authored paragraph or other text block. */
export function $isAtAuthoredParagraphEnd(): boolean {
  const range = $getSelection()
  if (!$isRangeSelection(range) || !range.isCollapsed()) return false
  const anchor = range.anchor
  let node = anchor.getNode()
  if ([node, ...node.getParents()].some($isProtectedComposerNode)) return false
  if ($isTextNode(node)) {
    if (anchor.offset !== node.getTextContentSize()) return false
  } else if ($isElementNode(node)) {
    if (anchor.offset !== node.getChildrenSize()) return false
  } else return false
  const root = $getRoot()
  while (node !== root) {
    if ($isElementNode(node) && !node.isInline()) return true
    const parent = node.getParent()
    if (!parent) return false
    if (node.getNextSiblings().some((sibling) => parent !== root || !$isProtectedComposerNode(sibling))) {
      return false
    }
    node = parent
  }
  return true
}

/** A transient drafting affordance. It never enters the Lexical document or draft autosave. */
export function ComposerBodyHintPlugin({
  showAiTip,
  suppressed = false
}: {
  showAiTip: boolean
  suppressed?: boolean
}): React.JSX.Element | null {
  const [editor] = useLexicalComposerContext()
  const [empty, setEmpty] = useState(false)
  const [idle, setIdle] = useState(true)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => {
    if (!idle || suppressed) return
    let frame = 0
    const update = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const root = editor.getRootElement()
        const container = root?.parentElement
        const selection = window.getSelection()
        const eligible = editor.getEditorState().read($isAtAuthoredParagraphEnd)
        if (
          !root ||
          !container ||
          !eligible ||
          !root.contains(document.activeElement) ||
          !selection?.isCollapsed ||
          !selection.rangeCount ||
          !root.contains(selection.anchorNode)
        ) {
          setPosition(null)
          return
        }
        let rect = selection.getRangeAt(0).getBoundingClientRect()
        let left = rect.right
        if (!rect.height) {
          const node = selection.anchorNode
          const element = node instanceof HTMLElement ? node : node?.parentElement
          if (!element) {
            setPosition(null)
            return
          }
          rect = element.getBoundingClientRect()
          left = rect.left
        }
        const bounds = container.getBoundingClientRect()
        const lineHeight = Number.parseFloat(getComputedStyle(root).lineHeight) || 24
        setPosition({
          left: left - bounds.left + container.scrollLeft,
          top: rect.top - Math.max(0, (lineHeight - rect.height) / 2) - bounds.top + container.scrollTop
        })
      })
    }
    const unregister = editor.registerUpdateListener(update)
    document.addEventListener('selectionchange', update)
    document.addEventListener('focusin', update)
    document.addEventListener('focusout', update)
    document.addEventListener('scroll', update, true)
    window.addEventListener('resize', update)
    update()
    return () => {
      cancelAnimationFrame(frame)
      unregister()
      document.removeEventListener('selectionchange', update)
      document.removeEventListener('focusin', update)
      document.removeEventListener('focusout', update)
      document.removeEventListener('scroll', update, true)
      window.removeEventListener('resize', update)
    }
  }, [editor, idle, suppressed])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const pause = (): void => {
      setIdle(false)
      clearTimeout(timer)
      timer = setTimeout(() => setIdle(true), AI_DRAFT_HINT_IDLE_MS)
    }
    setEmpty(editor.getEditorState().read(() => $authoredBodyIsEmpty()))
    const root = editor.getRootElement()
    root?.addEventListener('beforeinput', pause)
    const unregister = editor.registerUpdateListener(({ editorState, dirtyElements, dirtyLeaves }) => {
      setEmpty(editorState.read(() => $authoredBodyIsEmpty()))
      if (dirtyElements.size || dirtyLeaves.size) pause()
    })
    return () => {
      clearTimeout(timer)
      root?.removeEventListener('beforeinput', pause)
      unregister()
    }
  }, [editor])

  if (!showAiTip || suppressed || !idle || !position) return null

  return (
    <span
      data-testid="composer-ai-tip"
      aria-hidden="true"
      style={{ left: position.left, top: position.top, maxWidth: `calc(100% - ${position.left}px)` }}
      className="pointer-events-none absolute inline-flex items-center gap-2 overflow-hidden whitespace-nowrap text-xs leading-6 text-ink-faint select-none"
    >
      {empty ? 'Draft a reply with AI' : 'Continue draft with AI'} <Kbd>{modKeyLabel()} J</Kbd>
    </span>
  )
}
