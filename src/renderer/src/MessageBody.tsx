import DOMPurify from 'dompurify'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MessageAttachment } from '../../shared/mail'
import {
  MAIL_CID_SOURCE_MARKER as CID_SOURCE_MARKER,
  sanitizeMailHtml,
  MAIL_TRIM_MARKER as TRIM_MARKER
} from '../../shared/mailSanitizer'
import { forceLightMailCss } from './mailCss'
import { findTrimIndex } from './mailTrim'

interface MessageBodyProps {
  bodyText: string
  bodyHtml: string | null
  threadId: string
  messageId: string
  attachments: MessageAttachment[]
  expanded?: boolean
  onToggleTrim: () => void
}

const MAIL_VIEWPORT_HEIGHT = 800
const MAX_SAFE_BODY_HEIGHT = 100_000
const TRIM_CONTROL_HEIGHT = 28
const HORIZONTAL_SCROLLBAR_HEIGHT = 16
const MEANINGFUL_ELEMENTS = 'img, picture, svg, table, hr, video, audio, canvas'
const VIEWPORT_HEIGHT_UNIT = /(-?(?:\d+(?:\.\d+)?|\.\d+))(?:(?:d|l|s)?vh)\b/gi
const TRIM_SELECTOR = '.gmail_quote, .gmail_signature_prefix, .gmail_signature, blockquote[type="cite"]'
const EMPTY_IMAGES = new Map<string, string>()
const attn = window.attn

const RESET = `
  :root { color-scheme: only light; }
  html, body {
    margin: 0;
    padding: 0;
    background: #fff;
    color: #202124;
  }
  html { overflow-x: auto; overflow-y: hidden; }
  body { overflow: visible; }
  body {
    font: 14px/1.6 Arial, Helvetica, sans-serif;
    overflow-wrap: break-word;
  }
  #attn-mail-body {
    box-sizing: border-box;
    padding: 12px !important;
  }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  pre { white-space: pre-wrap; }
  [${TRIM_MARKER}] {
    display: block !important;
    height: ${TRIM_CONTROL_HEIGHT}px !important;
  }
`

interface FrameMeasurement {
  srcDoc: string
  fullHeight: number
  trimTop: number | null
  scrollbarHeight: number
}

function freezeViewportHeightUnits(css: string): string {
  return css.replace(VIEWPORT_HEIGHT_UNIT, (_, rawValue: string) => {
    return `${(Number(rawValue) * MAIL_VIEWPORT_HEIGHT) / 100}px`
  })
}

function normalizeMailLink(href: string): string | null {
  const value = href.trim()
  if (!value) return null
  if (value.startsWith('#')) return value
  if (value.startsWith('//')) return `https:${value}`
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return value
  if (/^(?:www\.)?[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+(?:[/?#]|$)/i.test(value)) {
    return `https://${value}`
  }
  return null
}

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName !== 'A') return
  const link = node as HTMLAnchorElement
  link.setAttribute('target', '_blank')
  link.setAttribute('rel', 'noopener noreferrer')
})

function hasRenderableContent(content: DocumentFragment): boolean {
  const visibleProbe = content.cloneNode(true) as DocumentFragment
  visibleProbe.querySelectorAll('style').forEach((style) => {
    style.remove()
  })
  return Boolean(visibleProbe.textContent?.trim()) || Boolean(visibleProbe.querySelector(MEANINGFUL_ELEMENTS))
}

function hasRenderableContentBefore(content: DocumentFragment, boundary: Element): boolean {
  const range = document.createRange()
  range.setStart(content, 0)
  range.setEndBefore(boundary)
  return hasRenderableContent(range.cloneContents())
}

function sanitizeToTemplate(html: string): HTMLTemplateElement | null {
  if (!html.trim()) return null
  const clean = sanitizeMailHtml(DOMPurify, html)

  const template = document.createElement('template')
  template.innerHTML = clean
  template.content.querySelectorAll('style').forEach((style) => {
    style.textContent = forceLightMailCss(freezeViewportHeightUnits(style.textContent ?? ''))
  })
  template.content.querySelectorAll<HTMLElement>('[style]').forEach((element) => {
    element.setAttribute('style', freezeViewportHeightUnits(element.getAttribute('style') ?? ''))
  })
  template.content.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((link) => {
    const normalizedHref = normalizeMailLink(link.getAttribute('href') ?? '')
    if (normalizedHref === null) link.removeAttribute('href')
    else link.setAttribute('href', normalizedHref)
  })
  if (!hasRenderableContent(template.content)) return null

  return template
}

function replaceCidSources(content: DocumentFragment, inlineImages: ReadonlyMap<string, string>): void {
  content.querySelectorAll<HTMLImageElement>('img[src]').forEach((image) => {
    const source = image.getAttribute('src')?.trim() ?? ''
    if (!source.toLowerCase().startsWith('cid:')) return
    const dataUrl = inlineImages.get(normalizedContentId(source.slice(4)))
    if (dataUrl) image.setAttribute('src', dataUrl)
    else {
      image.setAttribute(CID_SOURCE_MARKER, source)
      image.removeAttribute('src')
    }
  })
}

function normalizedContentId(value: string): string {
  try {
    return decodeURIComponent(value).replace(/^<|>$/g, '').toLowerCase()
  } catch {
    return value.replace(/^<|>$/g, '').toLowerCase()
  }
}

function cidReferences(html: string): string[] {
  if (!/cid:/i.test(html)) return []
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  return [...parsed.querySelectorAll<HTMLImageElement>('img[src]')]
    .map((image) => image.getAttribute('src')?.trim() ?? '')
    .filter((source) => source.toLowerCase().startsWith('cid:'))
    .map((source) => normalizedContentId(source.slice(4)))
}

function makeSrcDoc(html: string, inlineImages: ReadonlyMap<string, string>): string | null {
  const template = sanitizeToTemplate(html)
  if (!template) return null
  replaceCidSources(template.content, inlineImages)
  const trimMatch = template.content.querySelector<HTMLElement>(TRIM_SELECTOR)
  const trimStart = trimMatch && hasRenderableContentBefore(template.content, trimMatch) ? trimMatch : null
  if (trimStart) {
    const marker = document.createElement('div')
    marker.setAttribute(TRIM_MARKER, '')
    trimStart.before(marker)
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light"><base target="_blank"><style>${RESET}</style></head><body id="attn-mail-body">${template.innerHTML}</body></html>`
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
        lightSurface ? 'text-[#6b7280] hover:text-[#202124]' : 'text-ink-faint hover:text-ink'
      } ${className}`}
      style={style}
      title={label}
    >
      ...
    </button>
  )
}

export function MessageBody({
  bodyText,
  bodyHtml,
  threadId,
  messageId,
  attachments,
  expanded = false,
  onToggleTrim
}: MessageBodyProps): React.JSX.Element {
  const [measuredFrame, setMeasuredFrame] = useState<FrameMeasurement | null>(null)
  const [oversizedSrcDoc, setOversizedSrcDoc] = useState<string | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const keyDocumentRef = useRef<Document | null>(null)
  const inlineImagesRef = useRef<ReadonlyMap<string, string>>(EMPTY_IMAGES)
  const srcDoc = useMemo(() => (bodyHtml === null ? null : makeSrcDoc(bodyHtml, EMPTY_IMAGES)), [bodyHtml])

  const applyInlineImages = useCallback(() => {
    const doc = frameRef.current?.contentDocument
    if (!doc) return
    doc.querySelectorAll<HTMLImageElement>(`img[${CID_SOURCE_MARKER}]`).forEach((image) => {
      const source = image.getAttribute(CID_SOURCE_MARKER)?.trim() ?? ''
      const dataUrl = inlineImagesRef.current.get(normalizedContentId(source.slice(4)))
      if (!dataUrl) return
      image.setAttribute('src', dataUrl)
      image.removeAttribute(CID_SOURCE_MARKER)
    })
  }, [])

  useLayoutEffect(() => {
    inlineImagesRef.current = EMPTY_IMAGES
    if (bodyHtml === null || !attn) return
    const references = cidReferences(bodyHtml)
    const cidAttachments = attachments
      .filter((attachment) => attachment.mimeType.startsWith('image/'))
      .map((attachment) => {
        const filename = attachment.filename.toLowerCase()
        const contentIds = attachment.contentId
          ? [attachment.contentId.toLowerCase()]
          : references.filter((reference) => reference === filename || reference.startsWith(`${filename}@`))
        return { attachment, contentIds }
      })
      .filter(({ contentIds }) => contentIds.length > 0)
    const matchedReferences = new Set(cidAttachments.flatMap(({ contentIds }) => contentIds))
    if (references.some((reference) => !matchedReferences.has(reference))) {
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
    (frame: HTMLIFrameElement) => {
      const doc = frame.contentDocument
      if (!doc?.body) return
      const scrollHeight = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight, 1)
      if (scrollHeight > MAX_SAFE_BODY_HEIGHT) {
        setOversizedSrcDoc(srcDoc)
        return
      }
      const trimStart = doc.querySelector<HTMLElement>(`[${TRIM_MARKER}]`)
      const trimTop = trimStart
        ? Math.max(0, trimStart.getBoundingClientRect().top + (doc.defaultView?.scrollY ?? 0))
        : null
      const scrollbarHeight =
        doc.documentElement.scrollWidth > doc.documentElement.clientWidth ? HORIZONTAL_SCROLLBAR_HEIGHT : 0
      if (srcDoc !== null) {
        setMeasuredFrame({
          srcDoc,
          fullHeight: Math.ceil(scrollHeight + scrollbarHeight),
          trimTop,
          scrollbarHeight
        })
      }
    },
    [srcDoc]
  )

  const forwardKey = useCallback((event: KeyboardEvent) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return
    // Tab owns focus traversal inside the mail document. Forwarding it to the
    // app would prevent the browser from moving through links in the message.
    if (event.key === 'Tab') return
    const forwarded = new KeyboardEvent('keydown', {
      key: event.key,
      code: event.code,
      repeat: event.repeat,
      shiftKey: event.shiftKey,
      bubbles: true,
      cancelable: true
    })
    const parentTarget = frameRef.current ?? document.body
    parentTarget.dispatchEvent(forwarded)
    if (forwarded.defaultPrevented) event.preventDefault()
  }, [])

  const disconnect = useCallback(() => {
    observerRef.current?.disconnect()
    observerRef.current = null
    keyDocumentRef.current?.removeEventListener('keydown', forwardKey)
    keyDocumentRef.current = null
  }, [forwardKey])

  const observe = useCallback(
    (frame: HTMLIFrameElement) => {
      const doc = frame.contentDocument
      if (!doc?.body) return

      disconnect()
      applyInlineImages()
      measure(frame)
      const observer = new ResizeObserver(() => measure(frame))
      observer.observe(doc.body)
      observerRef.current = observer
      doc.addEventListener('keydown', forwardKey)
      keyDocumentRef.current = doc
    },
    [applyInlineImages, disconnect, forwardKey, measure]
  )

  const onLoad = useCallback(
    (event: React.SyntheticEvent<HTMLIFrameElement>) => {
      const frame = event.currentTarget
      frame.dataset.loadCount = String(Number(frame.dataset.loadCount ?? 0) + 1)
      observe(frame)
    },
    [observe]
  )

  useLayoutEffect(() => {
    if (srcDoc === null || oversized) return
    let frameId = 0
    const waitForSrcDoc = (): void => {
      const frame = frameRef.current
      if (frame?.contentWindow?.location.href === 'about:srcdoc' && frame.contentDocument?.body) {
        observe(frame)
        return
      }
      frameId = requestAnimationFrame(waitForSrcDoc)
    }
    frameId = requestAnimationFrame(waitForSrcDoc)
    return () => {
      cancelAnimationFrame(frameId)
      disconnect()
    }
  }, [disconnect, observe, oversized, srcDoc])

  if (srcDoc === null || oversized) {
    const lightSurface = bodyHtml !== null
    const surfaceClass = lightSurface ? 'p-3 text-[#202124]' : 'text-ink'
    const trimIndex = findTrimIndex(bodyText)
    if (trimIndex === null) {
      return (
        <div
          data-testid="plain-text-body"
          className={`whitespace-pre-wrap leading-[1.6] [overflow-wrap:break-word] ${surfaceClass}`}
        >
          {bodyText}
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
          {visibleText}
        </div>
        <TrimToggle
          expanded={expanded}
          lightSurface={lightSurface}
          onToggle={onToggleTrim}
          className="mt-1 block"
        />
        {expanded && (
          <div data-testid="plain-text-trimmed" className="whitespace-pre-wrap">
            {trimmedText}
          </div>
        )}
      </div>
    )
  }

  return (
    <div data-testid="html-body-container" className="relative min-w-0 bg-white">
      {measurement?.trimTop !== null && measurement?.trimTop !== undefined && (
        <TrimToggle
          expanded={expanded}
          lightSurface
          onToggle={onToggleTrim}
          className="absolute left-3 z-10 h-7"
          style={{ top: measurement.trimTop }}
        />
      )}
      <iframe
        ref={frameRef}
        data-testid="html-body-frame"
        title="HTML message body"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={srcDoc}
        onLoad={onLoad}
        className="block w-full border-0 bg-white"
        style={{
          colorScheme: 'light',
          height: height ?? 1,
          visibility: height === null ? 'hidden' : 'visible'
        }}
      />
    </div>
  )
}
