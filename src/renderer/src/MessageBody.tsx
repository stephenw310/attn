import DOMPurify from 'dompurify'
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { findTrimIndex } from './mailTrim'

interface MessageBodyProps {
  bodyText: string
  bodyHtml: string | null
  expanded?: boolean
  onToggleTrim: () => void
}

const MAIL_VIEWPORT_HEIGHT = 800
const MAX_SAFE_BODY_HEIGHT = 100_000
const TRIM_CONTROL_HEIGHT = 28
const HORIZONTAL_SCROLLBAR_HEIGHT = 16
const MEANINGFUL_ELEMENTS = 'img, picture, svg, table, hr, video, audio, canvas'
const VIEWPORT_HEIGHT_UNIT = /(-?(?:\d+(?:\.\d+)?|\.\d+))(?:(?:d|l|s)?vh)\b/gi
const TRIM_SELECTOR = '.gmail_quote, .gmail_signature, blockquote[type="cite"]'
const TRIM_MARKER = 'data-attn-trim-start'

const RESET = `
  :root { color-scheme: light; }
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
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  pre { white-space: pre-wrap; }
  [${TRIM_MARKER}]::before {
    content: '' !important;
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

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName !== 'A') return
  const link = node as HTMLAnchorElement
  link.setAttribute('target', '_blank')
  link.setAttribute('rel', 'noopener noreferrer')
})

function sanitizeToTemplate(html: string): HTMLTemplateElement | null {
  if (!html.trim()) return null
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea'],
    ADD_TAGS: ['style'],
    ADD_ATTR: ['target'],
    FORCE_BODY: true
  })

  const template = document.createElement('template')
  template.innerHTML = clean
  template.content.querySelectorAll('style').forEach((style) => {
    style.textContent = freezeViewportHeightUnits(style.textContent ?? '')
  })
  template.content.querySelectorAll<HTMLElement>('[style]').forEach((element) => {
    element.setAttribute('style', freezeViewportHeightUnits(element.getAttribute('style') ?? ''))
  })
  const visibleProbe = template.content.cloneNode(true) as DocumentFragment
  visibleProbe.querySelectorAll('style').forEach((style) => {
    style.remove()
  })
  const hasText = Boolean(visibleProbe.textContent?.trim())
  const hasRenderableElement = Boolean(template.content.querySelector(MEANINGFUL_ELEMENTS))
  if (!hasText && !hasRenderableElement) return null

  return template
}

function makeSrcDoc(html: string): string | null {
  const template = sanitizeToTemplate(html)
  if (!template) return null
  template.content.querySelector<HTMLElement>(TRIM_SELECTOR)?.setAttribute(TRIM_MARKER, '')

  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${RESET}</style></head><body>${template.innerHTML}</body></html>`
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
      onClick={onToggle}
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
  expanded = false,
  onToggleTrim
}: MessageBodyProps): React.JSX.Element {
  const [measuredFrame, setMeasuredFrame] = useState<FrameMeasurement | null>(null)
  const [oversizedSrcDoc, setOversizedSrcDoc] = useState<string | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const keyDocumentRef = useRef<Document | null>(null)
  const srcDoc = useMemo(() => (bodyHtml === null ? null : makeSrcDoc(bodyHtml)), [bodyHtml])

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
      measure(frame)
      const observer = new ResizeObserver(() => measure(frame))
      observer.observe(doc.body)
      observerRef.current = observer
      doc.addEventListener('keydown', forwardKey)
      keyDocumentRef.current = doc
    },
    [disconnect, forwardKey, measure]
  )

  const onLoad = useCallback(
    (event: React.SyntheticEvent<HTMLIFrameElement>) => observe(event.currentTarget),
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
    const trimIndex = findTrimIndex(bodyText)
    if (trimIndex === null) {
      return (
        <div
          data-testid="plain-text-body"
          className="whitespace-pre-wrap leading-[1.6] text-ink [overflow-wrap:break-word]"
        >
          {bodyText}
        </div>
      )
    }
    const visibleText = bodyText.slice(0, trimIndex).trimEnd()
    const trimmedText = bodyText.slice(trimIndex).trimStart()
    return (
      <div data-testid="plain-text-body" className="leading-[1.6] text-ink [overflow-wrap:break-word]">
        <div data-testid="plain-text-visible" className="whitespace-pre-wrap">
          {visibleText}
        </div>
        <TrimToggle expanded={expanded} lightSurface={false} onToggle={onToggleTrim} className="mt-1 block" />
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
      <iframe
        ref={frameRef}
        data-testid="html-body-frame"
        title="HTML message body"
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={srcDoc}
        onLoad={onLoad}
        className="block w-full border-0 bg-white"
        style={{ height: height ?? 1, visibility: height === null ? 'hidden' : 'visible' }}
      />
      {measurement?.trimTop !== null && measurement?.trimTop !== undefined && (
        <TrimToggle
          expanded={expanded}
          lightSurface
          onToggle={onToggleTrim}
          className="absolute left-3 z-10 h-7"
          style={{ top: measurement.trimTop }}
        />
      )}
    </div>
  )
}
