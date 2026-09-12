import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MessageAttachment } from '../../shared/mail'
import { MAIL_TRIM_MARKER as TRIM_MARKER } from '../../shared/mailSanitizer'
import type { ThemeAppearance } from '../../shared/theme'
import {
  applyResolvedCidImages,
  MailFrame,
  mailCidReferences,
  mailFrameDocument,
  MAIL_TRIM_COLLAPSED_ATTRIBUTE as TRIM_COLLAPSED_ATTRIBUTE,
  MAIL_TRIM_CONTROL_HEIGHT as TRIM_CONTROL_HEIGHT,
  useMailFrameAccess
} from './mailFrame'
import { matchInlineImageReferences } from './mailInlineImages'
import { mailTextParts } from './mailLinks'
import { findTrimIndex, type MailReadingParts } from './mailReading'
import { containsRemoteMailContent } from './mailRemoteContent'
import type { MailLayout, MailSurface } from './mailSurface'

interface MessageBodyProps {
  bodyText: string
  bodyHtml: string | null
  surface: MailSurface
  layout: MailLayout
  appearance: ThemeAppearance
  viewOriginal?: boolean
  parts?: MailReadingParts
  threadId: string
  messageId: string
  attachments: MessageAttachment[]
  expanded?: boolean
  onToggleTrim: () => void
}

const MAX_SAFE_BODY_HEIGHT = 100_000
const HORIZONTAL_SCROLLBAR_HEIGHT = 16
const EMPTY_IMAGES = new Map<string, string>()
const attn = window.attn

interface FrameMeasurement {
  srcDoc: string
  fullHeight: number
  trimTop: number | null
  scrollbarHeight: number
}

function LinkedMailText({ text, lightSurface }: { text: string; lightSurface: boolean }): React.JSX.Element {
  let offset = 0
  const content = mailTextParts(text).map((part) => {
    const start = offset
    offset += part.text.length
    return part.href ? (
      <a
        key={`${start}:${part.href}`}
        href={part.href}
        target="_blank"
        rel="noopener noreferrer"
        className={lightSurface ? 'text-mail-light-link' : 'text-mail-link'}
      >
        {part.text}
      </a>
    ) : (
      part.text
    )
  })
  return <>{content}</>
}

function TrimToggle({
  expanded,
  lightSurface,
  onToggle,
  className = '',
  style
}: {
  expanded: boolean
  lightSurface: boolean
  onToggle: () => void
  className?: string
  style?: React.CSSProperties
}): React.JSX.Element {
  const label = expanded ? 'Collapse quoted text and signature' : 'Show quoted text and signature'
  return (
    <button
      type="button"
      data-testid="mail-trim-toggle"
      aria-expanded={expanded}
      aria-label={label}
      onFocus={() => {
        // Reaching the ellipsis through normal Tab navigation reveals the
        // hidden trail without turning Tab into an app-wide shortcut.
        if (!expanded) onToggle()
      }}
      onMouseDown={(event) => {
        // Pointer activation has its own toggle path below; avoid firing the
        // keyboard-focus reveal immediately before the click.
        event.preventDefault()
      }}
      onClick={(event) => {
        onToggle()
        event.currentTarget.blur()
      }}
      className={`cursor-pointer border-0 bg-transparent px-0.5 text-sm font-normal tracking-normal ${
        lightSurface ? 'text-mail-light-ink-dim hover:text-mail-light-ink' : 'text-ink-faint hover:text-ink'
      } ${className}`}
      style={style}
      title={label}
    >
      ...
    </button>
  )
}

export function MessageBody(props: MessageBodyProps): React.JSX.Element {
  const { parts, expanded = false, onToggleTrim, viewOriginal } = props
  if (!parts || viewOriginal) return <SingleMessageBody {...props} />

  return (
    <div data-testid="mixed-mail-body" className="flex min-w-0 flex-col">
      {/* Keep the reveal control first in the tab order, as in a single mail frame. */}
      <TrimToggle
        expanded={expanded}
        lightSurface={false}
        onToggle={onToggleTrim}
        className="order-2 mt-1 h-7 self-start"
      />
      <div data-testid="mail-authored-section" className="order-1 min-w-0">
        <SingleMessageBody
          {...props}
          bodyHtml={parts.authoredHtml}
          bodyText={parts.authoredText}
          surface="native"
          layout="padded"
          expanded
          allowTrim={false}
        />
      </div>
      <div
        data-testid="mail-quoted-section"
        hidden={!expanded}
        className="order-3 min-w-0 overflow-hidden rounded-[10px] bg-mail-light-ground"
      >
        <SingleMessageBody
          {...props}
          bodyHtml={parts.quoteHtml}
          bodyText={parts.quoteText}
          surface={parts.quotePresentation.surface}
          layout={parts.quotePresentation.layout}
          expanded
          allowTrim={false}
          hidden={!expanded}
        />
      </div>
    </div>
  )
}

function SingleMessageBody({
  bodyText,
  bodyHtml,
  surface,
  layout,
  appearance,
  viewOriginal = false,
  threadId,
  messageId,
  attachments,
  expanded = false,
  onToggleTrim,
  allowTrim = true,
  hidden = false
}: MessageBodyProps & { allowTrim?: boolean; hidden?: boolean }): React.JSX.Element {
  const [measuredFrame, setMeasuredFrame] = useState<FrameMeasurement | null>(null)
  const [oversizedSrcDoc, setOversizedSrcDoc] = useState<string | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const inlineImagesRef = useRef<ReadonlyMap<string, string>>(EMPTY_IMAGES)
  const srcDoc = useMemo(
    () =>
      bodyHtml === null
        ? null
        : mailFrameDocument({
            html: bodyHtml,
            presentation: { surface, layout, appearance },
            viewOriginal,
            allowTrim
          }),
    [allowTrim, appearance, bodyHtml, layout, surface, viewOriginal]
  )

  // A collapsed quote frame mounts and loads with the message on purpose:
  // `mixed-mail.spec.ts` pins both documents present, each loaded exactly
  // once, so revealing the history costs no reload and no second image
  // request. (Deferring it to the first reveal was proposed as review P7;
  // it is that spec's contract, not an oversight.)
  const { access: frameAccess, loadOnce: loadImagesOnce } = useMailFrameAccess({
    messageId,
    enabled: srcDoc !== null
  })

  const applyInlineImages = useCallback(() => {
    const doc = frameRef.current?.contentDocument
    if (doc) applyResolvedCidImages(doc, inlineImagesRef.current)
  }, [])

  useLayoutEffect(() => {
    inlineImagesRef.current = EMPTY_IMAGES
    if (bodyHtml === null || !attn) return
    const references = mailCidReferences(bodyHtml)
    const cidAttachments = matchInlineImageReferences(attachments, references)
    const matchedReferences = new Set(cidAttachments.flatMap(({ contentIds }) => contentIds))
    if (references.some((reference) => !matchedReferences.has(reference.contentId))) {
      void attn.mail.repairInlineImages({ threadId }).catch(() => {})
    }
    let cancelled = false
    const addInlineImages = (entries: ReadonlyArray<readonly [string, string]>): void => {
      if (cancelled || entries.length === 0) return
      inlineImagesRef.current = new Map([...inlineImagesRef.current, ...entries])
      applyInlineImages()
    }

    void Promise.all(
      cidAttachments.map(async ({ attachment, contentIds }) => {
        const result = await attn.mail.getInlineImage({
          messageId,
          attachmentId: attachment.attachmentId,
          mimeType: attachment.mimeType
        })
        return 'dataUrl' in result ? contentIds.map((contentId) => [contentId, result.dataUrl] as const) : []
      })
    ).then((inlineResults) => addInlineImages(inlineResults.flat()))

    return () => {
      cancelled = true
    }
  }, [applyInlineImages, attachments, bodyHtml, messageId, threadId])

  const hasRemoteContent = useMemo(() => srcDoc !== null && containsRemoteMailContent(srcDoc), [srcDoc])
  const remoteImagesBanner = frameAccess?.blocked === true && !frameAccess.imagesAllowed && hasRemoteContent
  const alwaysLoadFromSender = useCallback(() => {
    // The override's sender is resolved from the store in the utility. The
    // policy-change broadcast re-registers this frame (and every other mounted
    // one) exactly once — no local epoch bump, or the frame would remount
    // twice and fetch a third time.
    void attn?.mail.allowRemoteImagesFromSender(messageId).catch(() => {})
  }, [messageId])

  const oversized = srcDoc !== null && oversizedSrcDoc === srcDoc
  const measurement = measuredFrame?.srcDoc === srcDoc ? measuredFrame : null
  const height =
    measurement === null
      ? null
      : expanded || measurement.trimTop === null
        ? measurement.fullHeight
        : Math.min(
            measurement.fullHeight,
            Math.ceil(measurement.trimTop + TRIM_CONTROL_HEIGHT + measurement.scrollbarHeight)
          )

  const measure = useCallback(
    (doc: Document) => {
      // A collapsed quote has no layout width. Measure only when it is revealed.
      if (hidden) return
      const scrollbarHeight =
        doc.documentElement.scrollWidth > doc.documentElement.clientWidth ? HORIZONTAL_SCROLLBAR_HEIGHT : 0
      doc.documentElement.style.setProperty('--attn-trim-scrollbar-height', `${scrollbarHeight}px`)
      doc.documentElement.toggleAttribute(TRIM_COLLAPSED_ATTRIBUTE, !expanded)
      const scrollHeight = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight, 1)
      if (scrollHeight > MAX_SAFE_BODY_HEIGHT) {
        setOversizedSrcDoc(srcDoc)
        return
      }
      const trimStart = doc.querySelector<HTMLElement>(`[${TRIM_MARKER}]`)
      const trimTop = trimStart
        ? Math.max(0, trimStart.getBoundingClientRect().top + (doc.defaultView?.scrollY ?? 0))
        : null
      if (srcDoc !== null) {
        const next = {
          srcDoc,
          fullHeight: Math.ceil(scrollHeight + scrollbarHeight),
          trimTop,
          scrollbarHeight
        }
        setMeasuredFrame((current) =>
          current?.srcDoc === next.srcDoc &&
          current.fullHeight === next.fullHeight &&
          current.trimTop === next.trimTop &&
          current.scrollbarHeight === next.scrollbarHeight
            ? current
            : next
        )
      }
    },
    [expanded, hidden, srcDoc]
  )

  if (srcDoc === null || oversized) {
    const lightSurface = surface === 'light'
    const surfaceClass = lightSurface ? 'p-3 text-mail-light-ink' : 'text-ink'
    const trimIndex = allowTrim ? findTrimIndex(bodyText) : null
    if (trimIndex === null) {
      return (
        <div
          data-testid="plain-text-body"
          className={`whitespace-pre-wrap leading-[1.6] [overflow-wrap:break-word] ${surfaceClass}`}
        >
          <LinkedMailText text={bodyText} lightSurface={lightSurface} />
        </div>
      )
    }
    const visibleText = bodyText.slice(0, trimIndex).trimEnd()
    const trimmedText = bodyText.slice(trimIndex).trimStart()
    return (
      <div
        data-testid="plain-text-body"
        className={`leading-[1.6] [overflow-wrap:break-word] ${surfaceClass}`}
      >
        <div data-testid="plain-text-visible" className="whitespace-pre-wrap">
          <LinkedMailText text={visibleText} lightSurface={lightSurface} />
        </div>
        <TrimToggle
          expanded={expanded}
          lightSurface={lightSurface}
          onToggle={onToggleTrim}
          className="mt-1 block"
        />
        {expanded && (
          <div data-testid="plain-text-trimmed" className="whitespace-pre-wrap">
            <LinkedMailText text={trimmedText} lightSurface={lightSurface} />
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      data-testid="html-body-container"
      data-surface={surface}
      data-layout={layout}
      data-appearance={appearance}
      className={`min-w-0 ${surface === 'light' ? 'bg-mail-light-ground' : 'bg-transparent'}`}
    >
      {remoteImagesBanner && (
        <div
          data-testid="remote-images-banner"
          className="mb-4 flex flex-wrap items-center gap-x-6 gap-y-3 rounded-md bg-active px-4 py-4 text-xs text-ink-dim"
        >
          <span className="min-w-0 flex-1">Remote images blocked</span>
          <button
            type="button"
            data-testid="remote-images-load-once"
            onClick={loadImagesOnce}
            className="cursor-pointer font-medium text-accent hover:underline"
          >
            Load once
          </button>
          <button
            type="button"
            data-testid="remote-images-always-allow"
            onClick={alwaysLoadFromSender}
            className="cursor-pointer font-medium text-accent hover:underline"
          >
            Always load from this sender
          </button>
        </div>
      )}
      {/* The trim toggle is offset against the frame, so the banner above
          must stay outside this relative wrapper. */}
      <div className="relative min-w-0">
        {measurement?.trimTop !== null && measurement?.trimTop !== undefined && (
          <TrimToggle
            expanded={expanded}
            lightSurface={surface === 'light'}
            onToggle={onToggleTrim}
            className="absolute left-0 z-10 h-7"
            style={{ top: measurement.trimTop }}
          />
        )}
        {frameAccess !== null && (
          <MailFrame
            access={frameAccess}
            frameRef={frameRef}
            data-testid="html-body-frame"
            title="HTML message body"
            srcDoc={srcDoc}
            onFrameLoad={applyInlineImages}
            onMeasure={measure}
            className={`block w-full border-0 ${
              surface === 'light' ? 'bg-mail-light-ground' : 'bg-transparent'
            }`}
            style={{
              colorScheme: surface === 'light' ? 'light' : appearance,
              height: height ?? 1,
              visibility: height === null ? 'hidden' : 'visible'
            }}
          />
        )}
      </div>
    </div>
  )
}
