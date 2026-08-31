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

// F8's manager: a T32 settings section editing the app-global snippet set with
// the same Lexical document the composer uses, so what is saved here is exactly
// what expansion inserts. Bodies are untrusted (rule 3): the import below and
// the serialize on save both run the composer sanitize path.

interface SnippetManagerProps {
  onToast: (message: string) => void
}

const NOTE = 'text-[11px] leading-relaxed text-ink-faint'
const ACTION_BUTTON =
  'cursor-pointer rounded-md border border-edge px-2.5 py-1 text-xs text-ink-dim hover:bg-active hover:text-ink disabled:cursor-default disabled:opacity-45 disabled:hover:bg-transparent'
const FIELD =
  'h-8 w-full rounded-md border border-edge bg-ground px-2 text-xs text-ink outline-none focus:border-accent'

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

export function SnippetManager({ onToast }: SnippetManagerProps): React.JSX.Element {
  const [snippets, setSnippets] = useState<Snippet[] | null>(null)
  const [editing, setEditing] = useState<EditingState | null>(null)
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

  return (
    <div className="flex flex-col gap-2">
      {(snippets ?? []).map((snippet) => (
        <div
          key={snippet.id}
          className="flex items-center justify-between gap-4 rounded-md border border-edge px-3 py-2"
          data-testid="settings-snippet-row"
          data-snippet-name={snippet.name}
        >
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] text-ink">{snippet.name}</span>
            {snippet.trigger && (
              <span className="shrink-0 rounded bg-active px-1.5 py-0.5 font-mono text-[11px] text-ink-dim">
                ;{snippet.trigger}
              </span>
            )}
            {snippet.subject && (
              <span className="min-w-0 truncate text-[11px] text-ink-faint">{snippet.subject}</span>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            <button
              type="button"
              className={ACTION_BUTTON}
              data-testid="settings-snippet-edit"
              onClick={() => openEditor(snippet)}
            >
              Edit
            </button>
            <button
              type="button"
              className={ACTION_BUTTON}
              data-testid="settings-snippet-delete"
              aria-label={`Delete snippet ${snippet.name}`}
              onClick={() => remove(snippet.id)}
            >
              Delete
            </button>
          </div>
        </div>
      ))}
      {snippets !== null && snippets.length === 0 && !editing && (
        <p className={NOTE} data-testid="settings-snippets-empty">
          Reusable text blocks for the composer: insert them from the palette (“Snippet: …”), the Mod+;
          picker, or by typing <span className="font-mono">;trigger</span> followed by a space.
        </p>
      )}
      {editing ? (
        <div
          className="flex flex-col gap-2 rounded-md border border-edge p-3"
          data-testid="settings-snippet-editor"
        >
          <div className="grid grid-cols-[1fr_140px] gap-2">
            <label className="flex flex-col gap-1 text-[11px] text-ink-faint">
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
            <label className="flex flex-col gap-1 text-[11px] text-ink-faint">
              Trigger (optional)
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
          <label className="flex flex-col gap-1 text-[11px] text-ink-faint">
            Subject (fills an empty subject, never overwrites)
            <input
              className={FIELD}
              data-testid="settings-snippet-subject"
              value={editing.subject}
              onChange={(event) =>
                setEditing((current) => current && { ...current, subject: event.target.value })
              }
            />
          </label>
          <div className="flex flex-col gap-1 text-[11px] text-ink-faint">
            Body — <span className="font-mono">{'{cursor}'}</span> marks where the caret lands
            {/* Keyed per target so switching rows remounts the editor: fresh
                document, fresh undo history. */}
            <LexicalComposer key={editing.id ?? 'new'} initialConfig={editorConfig}>
              <div className="relative rounded-md border border-edge bg-ground">
                <RichTextPlugin
                  contentEditable={
                    <ContentEditable
                      className="min-h-24 px-3 py-2 text-[13px] leading-5 text-ink outline-none"
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
          {error && (
            <p className="text-[11px] text-danger" data-testid="settings-snippet-error">
              {error}
            </p>
          )}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              className={ACTION_BUTTON}
              data-testid="settings-snippet-save"
              disabled={saving}
              onClick={save}
            >
              Save snippet
            </button>
            <button
              type="button"
              className={ACTION_BUTTON}
              data-testid="settings-snippet-cancel"
              disabled={saving}
              onClick={() => setEditing(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button
            type="button"
            className={ACTION_BUTTON}
            data-testid="settings-snippet-new"
            data-settings-control="snippets"
            onClick={() => openEditor(null)}
          >
            New snippet…
          </button>
        </div>
      )}
    </div>
  )
}
