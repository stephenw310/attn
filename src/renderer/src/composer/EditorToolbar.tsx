import { TOGGLE_LINK_COMMAND } from '@lexical/link'
import { INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND } from '@lexical/list'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $patchStyleText } from '@lexical/selection'
import {
  $getSelection,
  $isRangeSelection,
  FORMAT_ELEMENT_COMMAND,
  FORMAT_TEXT_COMMAND,
  type TextFormatType
} from 'lexical'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { safeUrl } from '../../../shared/html'
import { createCommand, registerCommands } from '../commands'
import { modKeyLabel } from '../platform'
import { toggleComposerQuoteBlock } from './bodyEditing'
import { COMPOSER_LINK_SCHEMES } from './sanitize'

function normalizeLink(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const normalized = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  return safeUrl(normalized, COMPOSER_LINK_SCHEMES)
}

export function EditorToolbar(): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkValue, setLinkValue] = useState('')
  const [linkInvalid, setLinkInvalid] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const linkInputRef = useRef<HTMLInputElement | null>(null)
  const moreRootRef = useRef<HTMLDivElement | null>(null)
  const morePanelRef = useRef<HTMLDivElement | null>(null)
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
  const quote = useCallback(() => toggleComposerQuoteBlock(editor), [editor])
  const openLink = useCallback((): void => {
    setMoreOpen(false)
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
  const runMoreAction = (action: () => void): void => {
    action()
    setMoreOpen(false)
    editor.focus()
  }

  useEffect(() => {
    if (linkOpen) linkInputRef.current?.focus()
  }, [linkOpen])

  useEffect(() => {
    if (moreOpen) morePanelRef.current?.focus()
  }, [moreOpen])

  useEffect(() => {
    if (!moreOpen) return
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!moreRootRef.current?.contains(event.target as Node)) setMoreOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [moreOpen])

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

  const button = 'cursor-pointer px-2 py-1 text-xs font-semibold text-ink-dim hover:bg-active hover:text-ink'
  const menuButton = `${button} text-left`

  return (
    <div
      className="flex min-w-0 flex-1 flex-nowrap items-center gap-0.5"
      role="toolbar"
      aria-label="Formatting toolbar"
    >
      <button
        type="button"
        className={button}
        aria-label="Bold"
        title={`Bold (${modKeyLabel()}B)`}
        onClick={() => format('bold')}
      >
        B
      </button>
      <button
        type="button"
        className={`${button} italic`}
        aria-label="Italic"
        title={`Italic (${modKeyLabel()}I)`}
        onClick={() => format('italic')}
      >
        I
      </button>
      <button
        type="button"
        className={`${button} underline`}
        aria-label="Underline"
        title={`Underline (${modKeyLabel()}U)`}
        onClick={() => format('underline')}
      >
        U
      </button>
      <div className="relative">
        <button
          type="button"
          className={button}
          data-testid="composer-link"
          aria-label="Add link"
          aria-expanded={linkOpen}
          title={`Add link (${modKeyLabel()}⇧K)`}
          onClick={openLink}
        >
          Link
        </button>
        {linkOpen && (
          <form
            className="absolute bottom-full left-0 z-30 mb-2 flex w-80 items-start gap-2 border border-edge bg-raised p-2 shadow-2xl"
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
                className="mt-1 h-8 w-full border border-edge bg-canvas px-2 text-xs text-ink outline-none focus:border-accent"
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
              className="mt-[17px] h-8 bg-accent/20 px-3 text-xs font-semibold text-accent"
            >
              Apply
            </button>
          </form>
        )}
      </div>
      <div ref={moreRootRef} className="relative">
        <button
          type="button"
          className={button}
          data-testid="composer-format-more"
          aria-label="More formatting"
          aria-expanded={moreOpen}
          onClick={() => {
            setLinkOpen(false)
            setMoreOpen((current) => !current)
          }}
        >
          More <span aria-hidden>⌄</span>
        </button>
        {moreOpen && (
          <div
            ref={morePanelRef}
            tabIndex={-1}
            role="dialog"
            aria-label="More formatting"
            className="absolute bottom-full left-0 z-30 mb-2 w-64 border border-edge bg-raised p-2 shadow-2xl"
            data-composer-transient
            data-testid="composer-format-menu"
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              event.stopPropagation()
              setMoreOpen(false)
              editor.focus()
            }}
          >
            <div className="grid grid-cols-2 gap-1">
              <button
                type="button"
                className={`${menuButton} line-through`}
                onClick={() => runMoreAction(() => format('strikethrough'))}
              >
                Strikethrough
              </button>
              <button type="button" className={menuButton} onClick={() => runMoreAction(quote)}>
                Block quote
              </button>
              <button
                type="button"
                className={menuButton}
                onClick={() =>
                  runMoreAction(() => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined))
                }
              >
                Bulleted list
              </button>
              <button
                type="button"
                className={menuButton}
                onClick={() =>
                  runMoreAction(() => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined))
                }
              >
                Numbered list
              </button>
            </div>
            <div className="my-2 h-px bg-edge" />
            <div className="grid grid-cols-2 gap-2">
              <label className="text-[11px] text-ink-faint">
                Font
                <select
                  data-testid="composer-font-family"
                  aria-label="Font family"
                  className="mt-1 h-8 w-full border border-edge bg-canvas px-2 text-xs text-ink-dim"
                  defaultValue=""
                  onChange={(event) => patchStyle('font-family', event.target.value)}
                >
                  <option value="" disabled>
                    Choose…
                  </option>
                  <option value="Arial, sans-serif">Arial</option>
                  <option value="Georgia, serif">Serif</option>
                  <option value="monospace">Monospace</option>
                </select>
              </label>
              <label className="text-[11px] text-ink-faint">
                Size
                <select
                  data-testid="composer-font-size"
                  aria-label="Font size"
                  className="mt-1 h-8 w-full border border-edge bg-canvas px-2 text-xs text-ink-dim"
                  defaultValue=""
                  onChange={(event) => patchStyle('font-size', event.target.value)}
                >
                  <option value="" disabled>
                    Choose…
                  </option>
                  <option value="12px">Small</option>
                  <option value="14px">Normal</option>
                  <option value="18px">Large</option>
                  <option value="24px">Huge</option>
                </select>
              </label>
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <span className="text-[11px] text-ink-faint">Colour</span>
              <label className="flex items-center gap-1 text-[11px] text-ink-dim" title="Text colour">
                Text
                <input
                  type="color"
                  data-testid="composer-text-color"
                  aria-label="Text colour"
                  className="size-6 border-0 bg-transparent p-0"
                  defaultValue="#202124"
                  onChange={(event) => patchStyle('color', event.target.value)}
                />
              </label>
              <label className="flex items-center gap-1 text-[11px] text-ink-dim" title="Background colour">
                Highlight
                <input
                  type="color"
                  data-testid="composer-background-color"
                  aria-label="Background colour"
                  className="size-6 border-0 bg-transparent p-0"
                  defaultValue="#fff2cc"
                  onChange={(event) => patchStyle('background-color', event.target.value)}
                />
              </label>
            </div>
            <div className="mt-2 flex items-center gap-1 border-t border-edge pt-2">
              <span className="mr-auto text-[11px] text-ink-faint">Alignment</span>
              <button
                type="button"
                className={button}
                aria-label="Align left"
                onClick={() => runMoreAction(() => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'left'))}
              >
                Left
              </button>
              <button
                type="button"
                className={button}
                aria-label="Align center"
                onClick={() => runMoreAction(() => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'center'))}
              >
                Center
              </button>
              <button
                type="button"
                className={button}
                aria-label="Align right"
                onClick={() => runMoreAction(() => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'right'))}
              >
                Right
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
