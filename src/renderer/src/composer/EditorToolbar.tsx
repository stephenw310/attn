import { TOGGLE_LINK_COMMAND } from '@lexical/link'
import { INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND } from '@lexical/list'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $createQuoteNode } from '@lexical/rich-text'
import { $setBlocksType } from '@lexical/selection'
import { $getSelection, $isRangeSelection, FORMAT_TEXT_COMMAND, type TextFormatType } from 'lexical'

function isSafeLink(value: string): boolean {
  return /^(?:https?:|mailto:)/i.test(value)
}

export function promptForLink(): string | null {
  const value = window.prompt('Link URL')?.trim()
  if (!value) return null
  const normalized = /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`
  return isSafeLink(normalized) ? normalized : null
}

export function EditorToolbar(): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  const format = (value: TextFormatType): void => {
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, value)
  }
  const button = 'rounded px-2 py-1 text-xs font-semibold text-ink-dim hover:bg-active hover:text-ink'

  return (
    <div className="flex items-center gap-0.5" role="toolbar" aria-label="Formatting toolbar">
      <button type="button" className={button} aria-label="Bold" onClick={() => format('bold')}>
        B
      </button>
      <button
        type="button"
        className={`${button} italic`}
        aria-label="Italic"
        onClick={() => format('italic')}
      >
        I
      </button>
      <button
        type="button"
        className={`${button} underline`}
        aria-label="Underline"
        onClick={() => format('underline')}
      >
        U
      </button>
      <span className="mx-1 h-4 w-px bg-edge" />
      <button
        type="button"
        className={button}
        aria-label="Bulleted list"
        onClick={() => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined)}
      >
        • List
      </button>
      <button
        type="button"
        className={button}
        aria-label="Numbered list"
        onClick={() => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined)}
      >
        1. List
      </button>
      <button
        type="button"
        className={button}
        aria-label="Block quote"
        onClick={() =>
          editor.update(() => {
            const selection = $getSelection()
            if ($isRangeSelection(selection)) $setBlocksType(selection, () => $createQuoteNode())
          })
        }
      >
        “ Quote
      </button>
      <button
        type="button"
        className={button}
        aria-label="Add link"
        onClick={() => {
          const url = promptForLink()
          if (url) editor.dispatchCommand(TOGGLE_LINK_COMMAND, url)
        }}
      >
        Link
      </button>
    </div>
  )
}
