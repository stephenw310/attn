import { TOGGLE_LINK_COMMAND } from '@lexical/link'
import { INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND } from '@lexical/list'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $createQuoteNode } from '@lexical/rich-text'
import { $patchStyleText, $setBlocksType } from '@lexical/selection'
import {
  $getSelection,
  $isRangeSelection,
  FORMAT_ELEMENT_COMMAND,
  FORMAT_TEXT_COMMAND,
  type TextFormatType
} from 'lexical'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createCommand, registerCommands } from '../commands'

function isSafeLink(value: string): boolean {
  return /^(?:https?:|mailto:)/i.test(value)
}

export function normalizeLink(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const normalized = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  return isSafeLink(normalized) ? normalized : null
}

export function EditorToolbar(): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkValue, setLinkValue] = useState('')
  const [linkInvalid, setLinkInvalid] = useState(false)
  const linkInputRef = useRef<HTMLInputElement | null>(null)
  const format = useCallback(
    (value: TextFormatType): void => {
      editor.dispatchCommand(FORMAT_TEXT_COMMAND, value)
    },
    [editor]
  )
  const patchStyle = useCallback(
    (property: string, value: string) => {
      editor.update(() => {
        const selection = $getSelection()
        if ($isRangeSelection(selection)) $patchStyleText(selection, { [property]: value })
      })
    },
    [editor]
  )
  const openLink = useCallback((): void => {
    setLinkInvalid(false)
    setLinkOpen(true)
  }, [])
  const closeLink = (): void => {
    setLinkOpen(false)
    setLinkValue('')
    setLinkInvalid(false)
    editor.focus()
  }
  const applyLink = (): void => {
    const url = normalizeLink(linkValue)
    if (!url) {
      setLinkInvalid(true)
      return
    }
    editor.dispatchCommand(TOGGLE_LINK_COMMAND, url)
    closeLink()
  }

  useEffect(() => {
    if (linkOpen) linkInputRef.current?.focus()
  }, [linkOpen])

  useLayoutEffect(
    () =>
      registerCommands([
        createCommand('composer.link', openLink),
        createCommand('composer.strikethrough', () => format('strikethrough')),
        createCommand('composer.fontFamily', () => patchStyle('font-family', 'Arial, sans-serif')),
        createCommand('composer.fontSize', () => patchStyle('font-size', '14px')),
        createCommand('composer.textColor', () => patchStyle('color', '#202124')),
        createCommand('composer.backgroundColor', () => patchStyle('background-color', '#fff2cc')),
        createCommand('composer.alignLeft', () => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'left')),
        createCommand('composer.alignCenter', () => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'center')),
        createCommand('composer.alignRight', () => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'right'))
      ]),
    [editor, format, openLink, patchStyle]
  )

  const button = 'rounded px-2 py-1 text-xs font-semibold text-ink-dim hover:bg-active hover:text-ink'

  return (
    <div
      className="flex min-w-0 flex-1 flex-wrap items-center gap-0.5"
      role="toolbar"
      aria-label="Formatting toolbar"
    >
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
      <button
        type="button"
        className={`${button} line-through`}
        aria-label="Strikethrough"
        onClick={() => format('strikethrough')}
      >
        S
      </button>
      <select
        data-testid="composer-font-family"
        aria-label="Font family"
        className="rounded bg-transparent px-1 py-1 text-xs text-ink-dim"
        defaultValue=""
        onChange={(event) => patchStyle('font-family', event.target.value)}
      >
        <option value="" disabled>
          Font
        </option>
        <option value="Arial, sans-serif">Arial</option>
        <option value="Georgia, serif">Serif</option>
        <option value="monospace">Monospace</option>
      </select>
      <select
        data-testid="composer-font-size"
        aria-label="Font size"
        className="rounded bg-transparent px-1 py-1 text-xs text-ink-dim"
        defaultValue=""
        onChange={(event) => patchStyle('font-size', event.target.value)}
      >
        <option value="" disabled>
          Size
        </option>
        <option value="12px">Small</option>
        <option value="14px">Normal</option>
        <option value="18px">Large</option>
        <option value="24px">Huge</option>
      </select>
      <label className="flex items-center" title="Text colour">
        <span className="sr-only">Text colour</span>
        <input
          type="color"
          data-testid="composer-text-color"
          aria-label="Text colour"
          className="size-6 border-0 bg-transparent p-0"
          defaultValue="#202124"
          onChange={(event) => patchStyle('color', event.target.value)}
        />
      </label>
      <label className="flex items-center" title="Background colour">
        <span className="sr-only">Background colour</span>
        <input
          type="color"
          data-testid="composer-background-color"
          aria-label="Background colour"
          className="size-6 border-0 bg-transparent p-0"
          defaultValue="#fff2cc"
          onChange={(event) => patchStyle('background-color', event.target.value)}
        />
      </label>
      <span className="mx-1 h-4 w-px bg-edge" />
      <button
        type="button"
        className={button}
        aria-label="Align left"
        onClick={() => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'left')}
      >
        ≡
      </button>
      <button
        type="button"
        className={button}
        aria-label="Align center"
        onClick={() => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'center')}
      >
        ≣
      </button>
      <button
        type="button"
        className={button}
        aria-label="Align right"
        onClick={() => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'right')}
      >
        ≡
      </button>
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
      <div className="relative">
        <button
          type="button"
          className={button}
          data-testid="composer-link"
          aria-label="Add link"
          aria-expanded={linkOpen}
          onClick={openLink}
        >
          Link
        </button>
        {linkOpen && (
          <form
            className="absolute bottom-full left-0 z-30 mb-2 flex w-80 items-start gap-2 rounded-lg border border-edge bg-raised p-2 shadow-2xl"
            data-composer-transient
            data-testid="composer-link-popover"
            onSubmit={(event) => {
              event.preventDefault()
              applyLink()
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              event.stopPropagation()
              closeLink()
            }}
          >
            <label className="min-w-0 flex-1 text-[11px] text-ink-faint">
              Link URL
              <input
                ref={linkInputRef}
                className="mt-1 h-8 w-full rounded-md border border-edge bg-canvas px-2 text-xs text-ink outline-none focus:border-accent"
                data-testid="composer-link-url"
                aria-invalid={linkInvalid ? 'true' : undefined}
                value={linkValue}
                placeholder="https://example.com"
                onChange={(event) => {
                  setLinkValue(event.target.value)
                  setLinkInvalid(false)
                }}
              />
            </label>
            <button
              type="submit"
              className="mt-[17px] h-8 rounded-md bg-accent/20 px-3 text-xs font-semibold text-accent"
            >
              Apply
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
