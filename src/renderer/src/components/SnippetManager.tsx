import { $generateNodesFromDOM } from '@lexical/html'
import { LexicalComposer } from '@lexical/react/LexicalComposer'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { ContentEditable } from '@lexical/react/LexicalContentEditable'
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary'
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin'
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin'
import { ListPlugin } from '@lexical/react/LexicalListPlugin'
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin'
import { $createParagraphNode, $getRoot, type LexicalEditor } from 'lexical'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { errorMessage } from '../../../shared/error'
import { normalizeSnippetTrigger, type Snippet } from '../../../shared/snippets'
import { editorConfig } from '../composer/editorConfig'
import { prepareHtmlForEditor } from '../composer/preserve'
import { preserveBlankLineBlocks, rootLevelNodes } from '../composer/rootNodes'
import { serializeEditorState } from '../composer/serialize'
import { useShowToast } from '../toastContext'
import { Kbd } from './Kbd'
import { NOTE } from './settingsStyles'

// F8's manager: a T32 settings section editing the app-global snippet set with
// the same Lexical document the composer uses, so what is saved here is exactly
// what expansion inserts. Bodies are untrusted (rule 3): the import below and
// the serialize on save both run the composer sanitize path.

const PRIMARY = 'cursor-pointer rounded-md bg-accent px-4 py-2.5 text-xs text-on-accent disabled:opacity-45'

const FIELD =
  'h-9 w-full rounded-md border border-edge bg-ground px-2.5 text-sm text-ink outline-none focus:border-accent'

function validateSnippetLinkUrl(url: string): boolean {
  return /^(?:https?:|mailto:)/i.test(url)
}

function InitialSnippetHtmlPlugin({ html }: { html: string }): null {
  const [editor] = useLexicalComposerContext()
  useLayoutEffect(() => {
    if (!html) return
    const dom = new DOMParser().parseFromString(prepareHtmlForEditor(html).html, 'text/html')
    preserveBlankLineBlocks(dom)
    editor.update(
      () => {
        const nodes = rootLevelNodes($generateNodesFromDOM(editor, dom))
        const root = $getRoot()
        root.clear()
        root.append(...(nodes.length > 0 ? nodes : [$createParagraphNode()]))
      },
      { tag: 'attn-initial-html' }
    )
  }, [editor, html])
  return null
}

function CaptureEditorPlugin({
  editorRef
}: {
  editorRef: React.MutableRefObject<LexicalEditor | null>
}): null {
  const [editor] = useLexicalComposerContext()
  useLayoutEffect(() => {
    editorRef.current = editor
    return () => {
      editorRef.current = null
    }
  }, [editor, editorRef])
  return null
}

interface EditingState {
  /** null while creating a new snippet. */
  id: string | null
  name: string
  trigger: string
  subject: string
  bodyHtml: string
}

export function SnippetManager(): React.JSX.Element {
  const onToast = useShowToast()
  const [snippets, setSnippets] = useState<Snippet[] | null>(null)
  const [editing, setEditing] = useState<EditingState | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const editorRef = useRef<LexicalEditor | null>(null)

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

  const openEditor = useCallback((snippet: Snippet | null) => {
    setError(null)
    setEditing(
      snippet
        ? {
            id: snippet.id,
            name: snippet.name,
            trigger: snippet.trigger ?? '',
            subject: snippet.subject ?? '',
            bodyHtml: snippet.bodyHtml
          }
        : { id: null, name: '', trigger: '', subject: '', bodyHtml: '' }
    )
  }, [])

  useEffect(() => {
    if (!editing) return
    const close = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || saving) return
      if (
        event.target instanceof Element &&
        event.target.closest('input, textarea, [contenteditable="true"]')
      )
        return
      event.preventDefault()
      event.stopImmediatePropagation()
      setEditing(null)
    }
    window.addEventListener('keydown', close, true)
    return () => window.removeEventListener('keydown', close, true)
  }, [editing, saving])

  const save = useCallback(() => {
    const bridge = window.attn
    const editor = editorRef.current
    if (!bridge || !editor || !editing || saving) return
    if (editing.name.trim() === '') {
      setError('Name the snippet before saving')
      return
    }
    const trigger = normalizeSnippetTrigger(editing.trigger)
    if (trigger === undefined) {
      setError('Triggers are a single word: letters and digits, with - or _ inside')
      return
    }
    const { bodyHtml } = serializeEditorState(editor.getEditorState(), editor)
    setSaving(true)
    setError(null)
    bridge.snippets
      .save({
        id: editing.id,
        name: editing.name.trim(),
        trigger,
        subject: editing.subject.trim() || null,
        bodyHtml
      })
      .then((list) => {
        setSnippets(list)
        setEditing(null)
        onToast('Snippet saved')
      })
      .catch((cause: unknown) => {
        const message = errorMessage(cause)
        setError(
          message.includes('already uses that trigger')
            ? 'Another snippet already uses that trigger'
            : 'Snippet could not be saved'
        )
      })
      .finally(() => setSaving(false))
  }, [editing, onToast, saving])

  const remove = useCallback(
    (id: string) => {
      void window.attn?.snippets
        .remove(id)
        .then((list) => {
          setSnippets(list)
          setEditing((current) => (current?.id === id ? null : current))
        })
        .catch(() => onToast('Snippet could not be deleted'))
    },
    [onToast]
  )

  const visibleSnippets = (snippets ?? [])
    .map((snippet) => ({
      ...snippet,
      preview:
        new DOMParser()
          .parseFromString(prepareHtmlForEditor(snippet.bodyHtml).html, 'text/html')
          .body.textContent?.replace(/\s+/g, ' ')
          .trim() ?? ''
    }))
    .filter((snippet) =>
      `${snippet.name} ${snippet.trigger ?? ''} ${snippet.preview}`
        .toLowerCase()
        .includes(query.toLowerCase())
    )

  return (
    <div className="flex flex-col gap-2">
      {!editing && (
        <>
          <div className="mb-3 flex items-center gap-3 border-b border-edge pb-3 text-ink-dim">
            <svg aria-hidden="true" viewBox="0 0 24 24" className="size-4 shrink-0 fill-none stroke-current">
              <circle cx="10" cy="10" r="7" />
              <path d="m15 15 6 6" />
            </svg>
            <input
              aria-label="Search snippets"
              data-testid="settings-snippet-search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search"
              className="min-w-0 flex-1 bg-transparent py-2 text-sm text-ink outline-none placeholder:text-ink-dim"
            />
          </div>
          {visibleSnippets.map((snippet) => (
            <button
              key={snippet.id}
              type="button"
              onClick={() => openEditor(snippet)}
              data-testid="settings-snippet-row"
              data-snippet-name={snippet.name}
              className="flex w-full items-center justify-between gap-4 rounded-md px-2 py-3 text-left hover:bg-active focus-visible:bg-active"
            >
              <span className="min-w-0">
                <span className="block truncate text-[13px] text-ink">{snippet.name}</span>
                <span className="mt-1 block truncate text-xs text-ink-dim">
                  {snippet.preview || snippet.subject}
                </span>
              </span>
              {snippet.trigger && <span className="shrink-0 text-xs text-ink-dim">;{snippet.trigger}</span>}
            </button>
          ))}
          {snippets !== null && visibleSnippets.length === 0 && (
            <p className={NOTE} data-testid="settings-snippets-empty">
              {query ? 'No matching snippets.' : 'No snippets yet.'}
            </p>
          )}
        </>
      )}
      {editing ? (
        <div className="flex flex-col gap-5" data-testid="settings-snippet-editor">
          <div className="mb-3 flex items-center justify-between">
            <h4 className="text-base font-medium text-ink">{editing.id ? 'Edit snippet' : 'New snippet'}</h4>
            <button
              type="button"
              data-testid="settings-snippet-cancel"
              onClick={() => setEditing(null)}
              disabled={saving}
              className="flex items-center gap-2 text-xs text-ink-dim"
            >
              Close <Kbd>Esc</Kbd>
            </button>
          </div>
          <div className="flex flex-col gap-5">
            <label className="flex flex-col gap-2 text-xs text-ink">
              Name
              <input
                className={FIELD}
                data-testid="settings-snippet-name"
                value={editing.name}
                onChange={(event) =>
                  setEditing((current) => current && { ...current, name: event.target.value })
                }
              />
            </label>
            <label className="flex flex-col gap-2 text-xs text-ink">
              Trigger · optional
              <input
                className={`${FIELD} font-mono`}
                data-testid="settings-snippet-trigger"
                placeholder=";intro"
                value={editing.trigger}
                onChange={(event) =>
                  setEditing((current) => current && { ...current, trigger: event.target.value })
                }
              />
            </label>
          </div>
          <label className="flex flex-col gap-2 text-xs text-ink">
            Subject · optional
            <input
              className={FIELD}
              data-testid="settings-snippet-subject"
              placeholder="Keep the draft’s subject"
              value={editing.subject}
              onChange={(event) =>
                setEditing((current) => current && { ...current, subject: event.target.value })
              }
            />
          </label>
          <div className="flex flex-col gap-2 text-xs text-ink">
            Message
            {/* Keyed per target so switching rows remounts the editor: fresh
                document, fresh undo history. */}
            <LexicalComposer key={editing.id ?? 'new'} initialConfig={editorConfig}>
              <div className="relative rounded-md border border-edge bg-ground">
                <RichTextPlugin
                  contentEditable={
                    <ContentEditable
                      className="min-h-[140px] px-3 py-2 text-[13px] leading-5 text-ink outline-none"
                      data-testid="settings-snippet-body"
                      aria-label="Snippet body"
                    />
                  }
                  placeholder={
                    <div className="pointer-events-none absolute left-3 top-2 text-[13px] leading-5 text-ink-faint">
                      Write the snippet…
                    </div>
                  }
                  ErrorBoundary={LexicalErrorBoundary}
                />
                <HistoryPlugin />
                <ListPlugin />
                <LinkPlugin validateUrl={validateSnippetLinkUrl} />
                <InitialSnippetHtmlPlugin html={editing.bodyHtml} />
                <CaptureEditorPlugin editorRef={editorRef} />
              </div>
            </LexicalComposer>
          </div>
          <p className={NOTE}>
            Use {'{cursor}'} to place the caret after insertion. A subject fills an empty draft subject only.
          </p>
          {error && (
            <p className="text-[11px] text-danger" data-testid="settings-snippet-error">
              {error}
            </p>
          )}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className={PRIMARY}
              data-testid="settings-snippet-save"
              disabled={saving}
              onClick={save}
            >
              Save snippet
            </button>
            {editing.id && (
              <button
                type="button"
                data-testid="settings-snippet-delete"
                onClick={() => remove(editing.id as string)}
                disabled={saving}
                className="ml-auto text-xs text-ink-dim hover:text-danger"
              >
                Delete snippet
              </button>
            )}
          </div>
        </div>
      ) : (
        <div>
          <button
            type="button"
            className={PRIMARY}
            data-testid="settings-snippet-new"
            data-settings-control="snippets"
            onClick={() => openEditor(null)}
          >
            New snippet
          </button>
        </div>
      )}
    </div>
  )
}
