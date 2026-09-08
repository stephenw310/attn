import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  applyResolvedCidImages,
  MailFrame,
  mailCidReferences,
  mailFrameDocument,
  useMailFrameAccess
} from '../mailFrame'
import { mailPresentationForHtml } from '../mailSurface'
import { useTheme } from '../theme'

const QUOTE_MAX_HEIGHT = 720
const NO_INLINE_IMAGES: ReadonlyMap<string, string> = new Map()

/**
 * The quoted history under a reply or forward. It renders through the reader's
 * display pipeline, not the outgoing allowlist (BUG-12): a quoted newsletter's
 * headings, rules and stylesheets used to be flattened here while the reader
 * and the recipient both saw them.
 */
export function InlineQuote({
  draftId,
  html,
  sourceMessageId,
  expanded: controlledExpanded,
  showToggle = true
}: {
  draftId: string
  html: string
  /** The quoted message, so per-sender remote-image exceptions apply (T33). */
  sourceMessageId: string | null
  expanded?: boolean
  showToggle?: boolean
}): React.JSX.Element | null {
  const [localExpanded, setLocalExpanded] = useState(false)
  const expanded = controlledExpanded ?? localExpanded
  const { appearance } = useTheme()
  const [height, setHeight] = useState(1)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const inlineImagesRef = useRef<ReadonlyMap<string, string>>(NO_INLINE_IMAGES)

  // T33: the quote is the same untrusted mail HTML the reader frames render,
  // so it registers under the quoted message — an Always-load-from-sender
  // exception covers a reply's quoted history too (PR #101 review). Without a
  // source id the frame stays unnamed and fails closed while blocking is on.
  const { access } = useMailFrameAccess({
    messageId: sourceMessageId,
    enabled: expanded && html !== ''
  })
  const blockRemoteImages = access !== null && !access.imagesAllowed

  const presentation = useMemo(
    () => ({ ...mailPresentationForHtml(html), appearance, scrollable: true }),
    [appearance, html]
  )
  // One srcDoc for the life of the frame: CID images that resolve later are
  // written into the loaded document instead, because setting `srcDoc` twice
  // reloads the frame and visibly collapses the quote in between.
  const srcDoc = useMemo(
    () => (html ? mailFrameDocument({ html, presentation, blockRemoteImages }) : null),
    [blockRemoteImages, html, presentation]
  )

  const applyInlineImages = useCallback(() => {
    const frameDocument = frameRef.current?.contentDocument
    if (frameDocument) applyResolvedCidImages(frameDocument, inlineImagesRef.current)
  }, [])

  useEffect(() => {
    inlineImagesRef.current = NO_INLINE_IMAGES
    const contentIds = [...new Set(mailCidReferences(html).map(({ contentId }) => contentId))]
    if (contentIds.length === 0 || !window.attn) return
    let cancelled = false
    void Promise.all(
      contentIds.map(async (contentId) => {
        const result = await window.attn?.draft.getInlineImage(draftId, contentId)
        return result && 'dataUrl' in result ? [[contentId, result.dataUrl] as const] : []
      })
    ).then((entries) => {
      if (cancelled) return
      inlineImagesRef.current = new Map(entries.flat())
      applyInlineImages()
    })
    return () => {
      cancelled = true
    }
  }, [applyInlineImages, draftId, html])

  const measure = useCallback((frameDocument: Document) => {
    const next = Math.max(frameDocument.documentElement.scrollHeight, frameDocument.body.scrollHeight, 1)
    setHeight(Math.min(next, QUOTE_MAX_HEIGHT))
  }, [])

  if (!html || (!expanded && !showToggle)) return null
  return (
    <div className="mx-5 mb-5 text-sm text-ink-dim" data-testid="composer-quote-container">
      {expanded && access !== null && srcDoc !== null && (
        <MailFrame
          access={access}
          frameRef={frameRef}
          title="Quoted history"
          data-testid="composer-quote"
          data-surface={presentation.surface}
          data-layout={presentation.layout}
          data-appearance={appearance}
          className={`block w-full border-0 ${
            presentation.surface === 'light' ? 'bg-mail-light-ground' : 'bg-transparent'
          }`}
          srcDoc={srcDoc}
          onFrameLoad={applyInlineImages}
          onMeasure={measure}
          style={{
            colorScheme: presentation.surface === 'light' ? 'light' : appearance,
            height
          }}
        />
      )}
      {showToggle && (
        <button
          type="button"
          className={`${expanded ? 'mt-1' : ''} block cursor-pointer border-0 bg-transparent px-0.5 text-sm font-normal tracking-normal text-ink-faint hover:text-ink`}
          data-testid="composer-quote-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide quoted history' : 'Show quoted history'}
          data-tooltip={expanded ? 'Hide quoted history' : 'Show quoted history'}
          onClick={() => setLocalExpanded((current) => !current)}
        >
          ...
        </button>
      )}
    </div>
  )
}
