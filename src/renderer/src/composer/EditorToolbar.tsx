import { TOGGLE_LINK_COMMAND } from '@lexical/link'
import { INSERT_ORDERED_LIST_COMMAND, INSERT_UNORDERED_LIST_COMMAND } from '@lexical/list'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $patchStyleText } from '@lexical/selection'
import {
  $getNodeByKey,
  $getSelection,
  $isDecoratorNode,
  $isRangeSelection,
  $setSelection,
  FORMAT_ELEMENT_COMMAND,
  FORMAT_TEXT_COMMAND,
  type LexicalNode,
  type RangeSelection,
  type TextFormatType
} from 'lexical'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { safeUrl } from '../../../shared/html'
import { createCommand, registerCommands } from '../commands'
import { MailIcon } from '../components/MailIcon'
import { modKeyLabel } from '../platform'
import { $clearSelectionFormatting, toggleComposerQuoteBlock } from './bodyEditing'
import { $isProtectedComposerNode, $topLevelComposerNode } from './nodes/protected'
import { COMPOSER_LINK_SCHEMES } from './sanitize'

function normalizeLink(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const normalized = /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`
  return safeUrl(normalized, COMPOSER_LINK_SCHEMES)
}

export function EditorToolbar(): React.JSX.Element {
  const [editor] = useLexicalComposerContext()
  const [fallbackOpen, setFallbackOpen] = useState(false)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [formats, setFormats] = useState<string[]>([])
  const savedSelection = useRef<RangeSelection | null>(null)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  const toolbarRef = useRef<HTMLDivElement | null>(null)
  const suppressed = useRef(false)
  const focusToolbar = useRef(false)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkValue, setLinkValue] = useState('')
  const [linkInvalid, setLinkInvalid] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const linkInputRef = useRef<HTMLInputElement | null>(null)
  const moreRootRef = useRef<HTMLDivElement | null>(null)
  const morePanelRef = useRef<HTMLDivElement | null>(null)
  const isReadOnlyNode = useCallback(
    (node: LexicalNode): boolean => {
      if ($isDecoratorNode(node)) return true
      const top = $topLevelComposerNode(node)
      if (!$isProtectedComposerNode(top)) return false
      return (
        top.getType() !== 'gmail-signature' ||
        editor.getElementByKey(top.getKey())?.getAttribute('contenteditable') !== null
      )
    },
    [editor]
  )
  const withSelection = useCallback(
    (action: () => void) => {
      editor.update(() => {
        const saved = savedSelection.current
        if (saved && $getNodeByKey(saved.anchor.key) && $getNodeByKey(saved.focus.key)) {
          $setSelection(saved.clone())
        }
        const selection = $getSelection()
        if (!$isRangeSelection(selection) || selection.getNodes().some(isReadOnlyNode)) return
        action()
      })
    },
    [editor, isReadOnlyNode]
  )

  useEffect(() => {
    let frame = 0
    const update = (): void => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const root = editor.getRootElement()
        if (!root) return
        let selected = false
        editor.getEditorState().read(() => {
          const selection = $getSelection()
          const valid = $isRangeSelection(selection) && !selection.getNodes().some(isReadOnlyNode)
          if (selection && !valid) savedSelection.current = null
          if (valid && $isRangeSelection(selection)) {
            savedSelection.current = selection.clone()
            selected = !selection.isCollapsed()
            setFormats(
              ['bold', 'italic', 'underline'].filter((format) =>
                selection.hasFormat(format as TextFormatType)
              )
            )
          }
        })
        const dom = window.getSelection()
        const range = dom?.rangeCount ? dom.getRangeAt(0) : null
        const inEditor = range && root.contains(range.commonAncestorContainer)
        const inToolbar = toolbarRef.current?.contains(document.activeElement)
        if (!fallbackOpen && !linkOpen && !moreOpen && (!selected || !inEditor || suppressed.current)) {
          if (!inToolbar) setPosition(null)
          return
        }
        if (!inEditor && inToolbar && !fallbackOpen) return
        const rect =
          fallbackOpen || !inEditor
            ? triggerRef.current?.getBoundingClientRect()
            : range?.getBoundingClientRect()
        if (!rect) return
        const bounds = root.getBoundingClientRect()
        const width = toolbarRef.current?.offsetWidth || 300
        const height = toolbarRef.current?.offsetHeight || 40
        const minLeft = Math.max(8, bounds.left)
        const maxLeft = Math.max(minLeft, Math.min(window.innerWidth - 8, bounds.right) - width)
        const top = rect.top - height - 8 >= Math.max(8, bounds.top) ? rect.top - height - 8 : rect.bottom + 8
        setPosition({
          left: Math.max(minLeft, Math.min(rect.left, maxLeft)),
          top: Math.max(8, Math.min(top, window.innerHeight - height - 8))
        })
      })
    }
    const selectionChanged = (): void => {
      if (editor.getRootElement()?.contains(document.activeElement)) suppressed.current = false
      update()
    }
    const outside = (event: PointerEvent): void => {
      if (
        toolbarRef.current?.contains(event.target as Node) ||
        triggerRef.current?.contains(event.target as Node)
      )
        return
      setFallbackOpen(false)
      setLinkOpen(false)
      setMoreOpen(false)
      suppressed.current = false
      update()
    }
    const unregister = editor.registerUpdateListener(update)
    document.addEventListener('selectionchange', selectionChanged)
    document.addEventListener('scroll', update, true)
    document.addEventListener('pointerdown', outside)
    window.addEventListener('resize', update)
    update()
    return () => {
      unregister()
      cancelAnimationFrame(frame)
      document.removeEventListener('selectionchange', selectionChanged)
      document.removeEventListener('scroll', update, true)
      document.removeEventListener('pointerdown', outside)
      window.removeEventListener('resize', update)
    }
  }, [editor, fallbackOpen, linkOpen, moreOpen, isReadOnlyNode])

  useLayoutEffect(() => {
    if (position && focusToolbar.current) {
      focusToolbar.current = false
      toolbarRef.current?.focus()
    }
  }, [position])

  useEffect(() => {
    if (!position || linkOpen || moreOpen) return
    const dismissFromEditor = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented ||
        event.key !== 'Escape' ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey
      )
        return
      const root = editor.getRootElement()
      if (!root?.contains(event.target as Node)) return
      event.preventDefault()
      event.stopPropagation()
      suppressed.current = true
      setPosition(null)
      setFallbackOpen(false)
    }
    document.addEventListener('keydown', dismissFromEditor, true)
    return () => document.removeEventListener('keydown', dismissFromEditor, true)
  }, [editor, position, linkOpen, moreOpen])

  const format = useCallback(
    (value: TextFormatType): void => {
      withSelection(() => editor.dispatchCommand(FORMAT_TEXT_COMMAND, value))
    },
    [editor, withSelection]
  )
  const clearFormatting = useCallback(() => {
    withSelection(() => $clearSelectionFormatting(editor))
  }, [editor, withSelection])
  const patchStyle = useCallback(
    (property: string, value: string) => {
      withSelection(() => {
        const selection = $getSelection()
        if ($isRangeSelection(selection)) $patchStyleText(selection, { [property]: value })
      })
    },
    [withSelection]
  )
  const quote = useCallback(() => toggleComposerQuoteBlock(editor), [editor])
  const openLink = useCallback((): void => {
    setFallbackOpen(true)
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
    withSelection(() => editor.dispatchCommand(TOGGLE_LINK_COMMAND, url))
    closeLink()
  }
  const runMoreAction = (action: () => void): void => {
    withSelection(action)
    setMoreOpen(false)
    editor.focus()
  }

  const toolbarMounted = position !== null
  useEffect(() => {
    if (toolbarMounted && linkOpen) linkInputRef.current?.focus()
  }, [linkOpen, toolbarMounted])

  useEffect(() => {
    if (toolbarMounted && moreOpen) morePanelRef.current?.focus()
  }, [moreOpen, toolbarMounted])

  useEffect(() => {
    if (!moreOpen || !toolbarMounted) return
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (!moreRootRef.current?.contains(event.target as Node)) setMoreOpen(false)
    }
    document.addEventListener('pointerdown', closeOnOutsidePointer)
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer)
  }, [moreOpen, toolbarMounted])

  useLayoutEffect(
    () =>
      registerCommands([
        createCommand('composer.format', () => {
          focusToolbar.current = true
          setFallbackOpen(true)
        }),
        createCommand('composer.link', openLink),
        createCommand('composer.clearFormatting', clearFormatting),
        createCommand('composer.strikethrough', () => format('strikethrough')),
        createCommand('composer.fontFamily', () => patchStyle('font-family', 'Arial, sans-serif')),
        createCommand('composer.fontSize', () => patchStyle('font-size', '14px')),
        createCommand('composer.textColor', () => patchStyle('color', '#202124')),
        createCommand('composer.backgroundColor', () => patchStyle('background-color', '#fff2cc')),
        createCommand('composer.alignLeft', () => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'left')),
        createCommand('composer.alignCenter', () => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'center')),
        createCommand('composer.alignRight', () => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'right'))
      ]),
    [editor, format, openLink, patchStyle, clearFormatting]
  )

  const button =
    'cursor-pointer rounded px-2 py-1 text-xs font-semibold text-ink-dim hover:bg-active hover:text-ink aria-pressed:bg-active'
  const menuButton = `${button} text-left`

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        data-testid="composer-format-toggle"
        aria-label="Formatting"
        aria-expanded={position !== null}
        data-tooltip={`Formatting (${modKeyLabel()}⇧F)`}
        className="flex h-8 items-center rounded-md px-2 text-sm text-ink-dim hover:bg-active hover:text-ink"
        onPointerDown={(event) => event.preventDefault()}
        onClick={(event) => {
          focusToolbar.current = event.detail === 0 && !fallbackOpen
          suppressed.current = fallbackOpen
          setFallbackOpen(!fallbackOpen)
          if (fallbackOpen) {
            setPosition(null)
            setLinkOpen(false)
            setMoreOpen(false)
          }
        }}
      >
        Aa
      </button>
      {position &&
        createPortal(
          <div
            ref={toolbarRef}
            data-testid="composer-selection-toolbar"
            data-composer-transient
            style={{ left: position.left, top: position.top }}
            onPointerDown={(event) => {
              if ((event.target as Element).closest('button')) event.preventDefault()
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Escape') return
              event.preventDefault()
              event.stopPropagation()
              suppressed.current = true
              setPosition(null)
              setFallbackOpen(false)
              setMoreOpen(false)
              setLinkOpen(false)
              triggerRef.current?.focus()
            }}
            className="outline-none fixed z-[110] flex max-w-[calc(100vw-16px)] flex-wrap items-center gap-0.5 rounded-md border border-edge bg-raised p-1.5 shadow-menu"
            tabIndex={-1}
            role="toolbar"
            aria-label="Formatting toolbar"
          >
            <button
              type="button"
              className={button}
              aria-label="Bold"
              aria-pressed={formats.includes('bold')}
              data-tooltip={`Bold (${modKeyLabel()}B)`}
              onClick={() => format('bold')}
            >
              B
            </button>
            <button
              type="button"
              className={`${button} italic`}
              aria-label="Italic"
              aria-pressed={formats.includes('italic')}
              data-tooltip={`Italic (${modKeyLabel()}I)`}
              onClick={() => format('italic')}
            >
              I
            </button>
            <button
              type="button"
              className={`${button} underline`}
              aria-label="Underline"
              aria-pressed={formats.includes('underline')}
              data-tooltip={`Underline (${modKeyLabel()}U)`}
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
                data-tooltip={`Add link (${modKeyLabel()}⇧K)`}
                onClick={openLink}
              >
                <MailIcon name="link" />
              </button>
              {linkOpen && (
                <form
                  className={`absolute right-0 z-30 flex w-80 max-w-[calc(100vw-24px)] items-start gap-2 rounded-md border border-edge bg-raised p-2 shadow-menu ${position.top > 320 ? 'bottom-full mb-2' : 'top-full mt-2'}`}
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
            <button
              type="button"
              className={button}
              aria-label="Bulleted list"
              data-tooltip={`Bulleted list (${modKeyLabel()}⇧8)`}
              onClick={() =>
                withSelection(() => editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined))
              }
            >
              • ≡
            </button>
            <button
              type="button"
              className={button}
              aria-label="Numbered list"
              data-tooltip={`Numbered list (${modKeyLabel()}⇧7)`}
              onClick={() =>
                withSelection(() => editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined))
              }
            >
              1 ≡
            </button>
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
                ⋯
              </button>
              {moreOpen && (
                <div
                  ref={morePanelRef}
                  tabIndex={-1}
                  role="dialog"
                  aria-label="More formatting"
                  className={`outline-none absolute right-0 z-30 max-h-[min(320px,50vh)] w-64 overflow-y-auto rounded-md border border-edge bg-raised p-2 shadow-menu ${position.top > 320 ? 'bottom-full mb-2' : 'top-full mt-2'}`}
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
                      className={menuButton}
                      onClick={() => runMoreAction(clearFormatting)}
                    >
                      Clear formatting
                    </button>
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
                        className="mt-1 h-8 w-full rounded-md border border-edge bg-canvas px-2 text-xs text-ink-dim"
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
                        className="mt-1 h-8 w-full rounded-md border border-edge bg-canvas px-2 text-xs text-ink-dim"
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
                    <label
                      className="flex items-center gap-1 text-[11px] text-ink-dim"
                      title="Background colour"
                    >
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
                      onClick={() =>
                        runMoreAction(() => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'left'))
                      }
                    >
                      Left
                    </button>
                    <button
                      type="button"
                      className={button}
                      aria-label="Align center"
                      onClick={() =>
                        runMoreAction(() => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'center'))
                      }
                    >
                      Center
                    </button>
                    <button
                      type="button"
                      className={button}
                      aria-label="Align right"
                      onClick={() =>
                        runMoreAction(() => editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, 'right'))
                      }
                    >
                      Right
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>,
          document.body
        )}
    </>
  )
}
