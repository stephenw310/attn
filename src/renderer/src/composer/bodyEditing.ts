import { TOGGLE_LINK_COMMAND } from '@lexical/link'
import { INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND } from '@lexical/list'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $createQuoteNode } from '@lexical/rich-text'
import { $setBlocksType } from '@lexical/selection'
import {
  $addUpdateTag,
  $createParagraphNode,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  FORMAT_TEXT_COMMAND,
  HISTORY_PUSH_TAG,
  type LexicalEditor,
  type LexicalNode,
  REDO_COMMAND,
  UNDO_COMMAND
} from 'lexical'
import { useCallback, useEffect, useLayoutEffect } from 'react'
import { createCommand, registerCommands } from '../commands'
import { LegacyFontNode } from './nodes/LegacyFontNode'
import { $authoredChildCount, $isProtectedComposerNode, $topLevelComposerNode } from './nodes/protected'

/** Move the cleared run out of its legacy font wrapper; untouched neighbours keep the font. */
function $liftFromLegacyFont(font: LegacyFontNode, cleared: Set<string>): void {
  const children = font.getChildren()
  const first = children.findIndex((child) => cleared.has(child.getKey()))
  if (first < 0) return
  let last = first
  while (last + 1 < children.length && cleared.has(children[last + 1].getKey())) last += 1
  let anchor: LexicalNode = font
  for (const child of children.slice(first, last + 1)) {
    anchor.insertAfter(child)
    anchor = child
  }
  const tail = children.slice(last + 1)
  if (tail.length) {
    const latest = font.getLatest()
    const rest = new LegacyFontNode(latest.__attributes, latest.__autoDirection).setStyle(font.getStyle())
    anchor.insertAfter(rest)
    rest.append(...tail)
  }
  if (font.getChildrenSize() === 0) font.remove()
}

/**
 * Clear formatting: the formatting menu button and the palette command are the
 * same action. Text formats, styles, and links go, and a legacy font wrapper is
 * split so the cleared text leaves it. A collapsed caret clears what is typed next.
 */
export function $clearSelectionFormatting(editor: LexicalEditor): void {
  $addUpdateTag(HISTORY_PUSH_TAG)
  const selection = $getSelection()
  if (!$isRangeSelection(selection)) return
  if (!selection.isCollapsed()) {
    const extracted = selection.extract()
    const cleared = new Set(extracted.map((node) => node.getKey()))
    for (const node of extracted) {
      if ($isTextNode(node)) node.setFormat(0).setStyle('')
      for (let parent = node.getParent(); parent instanceof LegacyFontNode; parent = node.getParent()) {
        $liftFromLegacyFont(parent, cleared)
      }
    }
    editor.dispatchCommand(TOGGLE_LINK_COMMAND, null)
  }
  selection.setFormat(0)
  selection.setStyle('')
}

/**
 * Block-quoting the selection. The toolbar button and the palette command are
 * the same action, and each used to carry its own copy (review R6).
 */
export function toggleComposerQuoteBlock(editor: LexicalEditor): void {
  editor.update(() => {
    const selection = $getSelection()
    if ($isRangeSelection(selection)) $setBlocksType(selection, () => $createQuoteNode())
  })
}

interface CommandPluginProps {
  onAttach: () => void
  onRemoveAttachment: () => void
  onClose: () => void
  onDiscard: () => void
  onSend: () => void
  onFollowUp: () => void
}

export function ComposerCommandPlugin({
  onAttach,
  onRemoveAttachment,
  onClose,
  onDiscard,
  onSend,
  onFollowUp
}: CommandPluginProps): null {
  const [editor] = useLexicalComposerContext()
  const quote = useCallback(() => toggleComposerQuoteBlock(editor), [editor])
  useLayoutEffect(
    () =>
      registerCommands([
        createCommand('composer.close', onClose),
        createCommand('composer.undo', () => editor.dispatchCommand(UNDO_COMMAND, undefined)),
        createCommand('composer.discard', onDiscard),
        createCommand('composer.send', onSend),
        createCommand('composer.attach', onAttach),
        createCommand('composer.removeAttachment', onRemoveAttachment),
        createCommand('composer.followUp', onFollowUp),
        createCommand('composer.bold', () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'bold')),
        createCommand('composer.italic', () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'italic')),
        createCommand('composer.underline', () => editor.dispatchCommand(FORMAT_TEXT_COMMAND, 'underline')),
        createCommand('composer.bullets', () =>
          editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)
        ),
        createCommand('composer.numbering', () =>
          editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)
        ),
        createCommand('composer.quote', quote)
      ]),
    [editor, onAttach, onRemoveAttachment, onClose, onDiscard, onSend, onFollowUp, quote]
  )
  return null
}

function $selectionAnchorIsAuthored(): boolean {
  const selection = $getSelection()
  if (!$isRangeSelection(selection)) return false
  const node = $topLevelComposerNode(selection.anchor.getNode())
  return node !== $getRoot() && !$isProtectedComposerNode(node)
}

/**
 * Put the caret back where the user was typing, after an undo whose restored
 * state left it somewhere else. Undo replaces the whole editor state, and the
 * state it restores can carry no selection at all; the DOM selection then
 * survives from the replaced DOM and settles inside the signature or the
 * footer, so the next keystroke types into a protected node. Called only when
 * the caret was in the authored region before the undo, and it aims at the end
 * of that region rather than at whichever protected node the caret drifted
 * into — the authored text is one run at the top, never between two of them.
 */
function $restoreAuthoredCaret(): void {
  const selection = $getSelection()
  if ($isRangeSelection(selection)) {
    const anchored = $topLevelComposerNode(selection.anchor.getNode())
    if (anchored !== $getRoot() && !$isProtectedComposerNode(anchored)) return
  }
  const root = $getRoot()
  const children = root.getChildren()
  const authored = $authoredChildCount()
  const lastAuthored = authored > 0 ? children[authored - 1] : null
  if (lastAuthored) {
    lastAuthored.selectEnd()
    return
  }
  const paragraph = $createParagraphNode()
  const firstProtected = children[0]
  if (firstProtected) firstProtected.insertBefore(paragraph)
  else root.append(paragraph)
  paragraph.selectStart()
}

export function BodyEditingShortcutsPlugin(): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    const rootElement = editor.getRootElement()
    if (!rootElement) return
    const onKeyDown = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase()
      if ((key === 'backspace' || key === 'delete') && !event.metaKey && !event.ctrlKey && !event.altKey) {
        let deletesAuthoredRegion = false
        editor.getEditorState().read(() => {
          const selection = $getSelection()
          if (!$isRangeSelection(selection) || selection.isCollapsed()) return
          const root = $getRoot()
          const authoredCount = $authoredChildCount()
          const rootKey = root.getKey()
          deletesAuthoredRegion =
            selection.anchor.key === rootKey &&
            selection.focus.key === rootKey &&
            ((selection.anchor.offset === 0 && selection.focus.offset === authoredCount) ||
              (selection.focus.offset === 0 && selection.anchor.offset === authoredCount))
        })
        if (!deletesAuthoredRegion) return

        event.preventDefault()
        event.stopPropagation()
        editor.update(() => {
          $addUpdateTag(HISTORY_PUSH_TAG)
          const root = $getRoot()
          let firstProtectedNode = root.getFirstChild()
          while (firstProtectedNode && !$isProtectedComposerNode(firstProtectedNode)) {
            const next = firstProtectedNode.getNextSibling()
            firstProtectedNode.remove()
            firstProtectedNode = next
          }
          const paragraph = $createParagraphNode()
          if (firstProtectedNode) firstProtectedNode.insertBefore(paragraph)
          else root.append(paragraph)
          paragraph.selectStart()
        })
        return
      }

      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      if (key === 'z') {
        event.preventDefault()
        event.stopPropagation()
        const keepAuthoredCaret = editor.getEditorState().read(() => $selectionAnchorIsAuthored())
        editor.dispatchCommand(event.shiftKey ? REDO_COMMAND : UNDO_COMMAND, undefined)
        if (keepAuthoredCaret) editor.update(() => $restoreAuthoredCaret())
        return
      }
      if (key !== 'a' || event.shiftKey) return
      event.preventDefault()
      event.stopPropagation()
      editor.update(() => $getRoot().select(0, $authoredChildCount()))
    }
    rootElement.addEventListener('keydown', onKeyDown, true)
    return () => rootElement.removeEventListener('keydown', onKeyDown, true)
  }, [editor])
  return null
}
