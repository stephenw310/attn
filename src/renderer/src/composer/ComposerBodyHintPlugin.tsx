import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $getRoot, $isDecoratorNode, $isElementNode, type LexicalNode } from 'lexical'
import { useEffect, useState } from 'react'
import { modKeyLabel } from '../platform'
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

/** A transient empty-body affordance. It never enters the Lexical document or draft autosave. */
export function ComposerBodyHintPlugin({ showAiTip }: { showAiTip: boolean }): React.JSX.Element | null {
  const [editor] = useLexicalComposerContext()
  const [empty, setEmpty] = useState(false)

  useEffect(() => {
    const update = (): void => setEmpty(editor.getEditorState().read(() => $authoredBodyIsEmpty()))
    update()
    return editor.registerUpdateListener(({ editorState }) => {
      setEmpty(editorState.read(() => $authoredBodyIsEmpty()))
    })
  }, [editor])

  if (!showAiTip || !empty) return null
  return (
    <div
      data-testid="composer-ai-tip"
      className="pointer-events-none absolute left-5 top-5 text-[13px] leading-5 text-ink-faint select-none"
    >
      Tip: Hit {modKeyLabel()}J for AI
    </div>
  )
}
