import { $generateNodesFromDOM } from '@lexical/html'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $addUpdateTag,
  $getRoot,
  $getSelection,
  $insertNodes,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_HIGH,
  HISTORY_PUSH_TAG,
  KEY_ENTER_COMMAND,
  KEY_SPACE_COMMAND,
  type LexicalEditor
} from 'lexical'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { matchInlineSnippetTrigger, SNIPPET_CURSOR_MARKER, type Snippet } from '../../../shared/snippets'
import { createCommand, createSnippetInsertCommand, registerCommands } from '../commands'
import { prepareHtmlForEditor } from './preserve'
import { preserveBlankLineBlocks } from './rootNodes'

// F8 snippets in the composer: the palette command, the Mod+; picker, and the
// inline `;trigger ` expansion all run one insertion path — replace the trigger
// text (if any) with the snippet body, land the caret on {cursor}, and commit
// it as a single history entry so one Mod+Z reverses the whole expansion.

interface SnippetsPluginProps {
  /** Fired after any insertion; the composer applies the fill-only subject rule. */
  onInserted: (snippet: Snippet) => void
}

/**
 * Snippet bodies are untrusted (rule 3): they were sanitized by the manager on
 * save and pass the composer import path again here, so a tampered row cannot
 * smuggle markup past what pasting the same HTML could.
 */
function $insertSnippetBody(editor: LexicalEditor, bodyHtml: string): void {
  const dom = new DOMParser().parseFromString(prepareHtmlForEditor(bodyHtml).html, 'text/html')
  preserveBlankLineBlocks(dom)
  $insertNodes($generateNodesFromDOM(editor, dom))
  // {cursor} names the caret's landing point; the marker itself never survives
  // into the document. $insertNodes leaves the caret at the end otherwise.
  for (const text of $getRoot().getAllTextNodes()) {
    const index = text.getTextContent().indexOf(SNIPPET_CURSOR_MARKER)
    if (index < 0) continue
    text.spliceText(index, SNIPPET_CURSOR_MARKER.length, '', true)
    break
  }
}

export function SnippetsPlugin({ onInserted }: SnippetsPluginProps): React.JSX.Element | null {
  const [editor] = useLexicalComposerContext()
  const [snippets, setSnippets] = useState<Snippet[]>([])
  const [pickerOpen, setPickerOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlighted, setHighlighted] = useState(0)
  const snippetsRef = useRef(snippets)
  snippetsRef.current = snippets
  const onInsertedRef = useRef(onInserted)
  onInsertedRef.current = onInserted

  useEffect(() => {
    let stale = false
    window.attn?.snippets
      .list()
      .then((list) => {
        if (!stale) setSnippets(list)
      })
      .catch(() => {})
    return () => {
      stale = true
    }
  }, [])

  const insertSnippet = useCallback(
    (snippet: Snippet) => {
      setPickerOpen(false)
      editor.update(() => {
        $addUpdateTag(HISTORY_PUSH_TAG)
        $insertSnippetBody(editor, snippet.bodyHtml)
      })
      onInsertedRef.current(snippet)
      editor.focus()
    },
    [editor]
  )

  // The inline trigger fires only on the space or Enter that completes the
  // full `;word` (T34: deliberate, not eager). The keystroke is spent by the
  // expansion, and the HISTORY_PUSH tag keeps the replacement out of the
  // typing coalescing entry so one undo restores the literal `;word`.
  useEffect(() => {
    const expand = (event: KeyboardEvent | null): boolean => {
      if (editor.isComposing() || snippetsRef.current.length === 0) return false
      const selection = $getSelection()
      if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false
      const anchor = selection.anchor
      if (anchor.type !== 'text') return false
      const node = anchor.getNode()
      if (!$isTextNode(node)) return false
      const match = matchInlineSnippetTrigger(node.getTextContent().slice(0, anchor.offset))
      if (!match) return false
      const snippet = snippetsRef.current.find((candidate) => candidate.trigger === match.trigger)
      if (!snippet) return false
      event?.preventDefault()
      $addUpdateTag(HISTORY_PUSH_TAG)
      node.spliceText(match.start, anchor.offset - match.start, '', true)
      $insertSnippetBody(editor, snippet.bodyHtml)
      onInsertedRef.current(snippet)
      return true
    }
    const unregisterSpace = editor.registerCommand(KEY_SPACE_COMMAND, expand, COMMAND_PRIORITY_HIGH)
    const unregisterEnter = editor.registerCommand(KEY_ENTER_COMMAND, expand, COMMAND_PRIORITY_HIGH)
    return () => {
      unregisterSpace()
      unregisterEnter()
    }
  }, [editor])

  const openPicker = useCallback(() => {
    setQuery('')
    setHighlighted(0)
    setPickerOpen(true)
    // Refresh so a snippet managed in Settings while this draft sat open is
    // pickable without reopening the composer.
    void window.attn?.snippets
      .list()
      .then(setSnippets)
      .catch(() => {})
  }, [])

  useLayoutEffect(
    () =>
      registerCommands([
        createCommand('composer.snippets', openPicker),
        ...snippets.map((snippet) =>
          createSnippetInsertCommand(snippet.id, snippet.name, () => insertSnippet(snippet))
        )
      ]),
    [insertSnippet, openPicker, snippets]
  )

  if (!pickerOpen) return null

  const lowered = query.trim().toLowerCase()
  const visible = snippets.filter(
    (snippet) =>
      lowered === '' ||
      snippet.name.toLowerCase().includes(lowered) ||
      (snippet.trigger ?? '').includes(lowered)
  )
  const highlightedIndex = Math.min(highlighted, Math.max(visible.length - 1, 0))

  const closePicker = (): void => {
    setPickerOpen(false)
    editor.focus()
  }

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keyboard container for the focused filter input; Escape/arrows/Enter are its whole interface
    <div
      className="absolute inset-x-0 top-0 z-30 flex justify-center p-3"
      data-composer-transient
      data-testid="snippet-picker"
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.preventDefault()
          event.stopPropagation()
          closePicker()
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          event.stopPropagation()
          const delta = event.key === 'ArrowDown' ? 1 : -1
          setHighlighted(Math.min(Math.max(highlightedIndex + delta, 0), Math.max(visible.length - 1, 0)))
        } else if (event.key === 'Enter') {
          event.preventDefault()
          event.stopPropagation()
          const snippet = visible[highlightedIndex]
          if (snippet) insertSnippet(snippet)
        }
      }}
    >
      <div className="w-full max-w-md overflow-hidden rounded-lg border border-edge bg-raised shadow-2xl">
        <input
          className="h-9 w-full border-b border-edge bg-transparent px-3 text-sm text-ink outline-none placeholder:text-ink-faint"
          data-testid="snippet-picker-input"
          aria-label="Insert snippet"
          placeholder="Insert snippet…"
          // biome-ignore lint/a11y/noAutofocus: the picker is a keyboard-invoked transient; focusing its filter is the point
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setHighlighted(0)
          }}
        />
        {visible.length === 0 ? (
          <div className="px-3 py-2.5 text-xs text-ink-faint" data-testid="snippet-picker-empty">
            {snippets.length === 0 ? 'No snippets yet — create them in Settings' : 'No matching snippets'}
          </div>
        ) : (
          <ul className="max-h-64 overflow-y-auto py-1">
            {visible.map((snippet, index) => (
              <li key={snippet.id}>
                <button
                  type="button"
                  className={`flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm ${
                    index === highlightedIndex ? 'bg-active text-ink' : 'text-ink-dim hover:bg-active'
                  }`}
                  data-testid="snippet-picker-item"
                  data-snippet-id={snippet.id}
                  onClick={() => insertSnippet(snippet)}
                >
                  <span className="min-w-0 flex-1 truncate">{snippet.name}</span>
                  {snippet.trigger && (
                    <span className="shrink-0 font-mono text-[11px] text-ink-faint">;{snippet.trigger}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
