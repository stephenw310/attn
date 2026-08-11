import DOMPurify from 'dompurify'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { findTrimIndex } from './mailTrim'

interface MessageBodyProps {
  bodyText: string
  bodyHtml: string | null
  expanded?: boolean
}

const MAIL_VIEWPORT_HEIGHT = 800
const MAX_SAFE_BODY_HEIGHT = 100_000
const MEANINGFUL_ELEMENTS = 'img, picture, svg, table, hr, video, audio, canvas'
const VIEWPORT_HEIGHT_UNIT = /(-?(?:\d+(?:\.\d+)?|\.\d+))(?:(?:d|l|s)?vh)\b/gi
const TRIM_SELECTOR = '.gmail_quote, .gmail_signature, blockquote[type="cite"]'
const HIDE_TRIM = `${TRIM_SELECTOR} { display: none !important; }`

const RESET = `
  :root { color-scheme: light; }
  html, body {
    margin: 0;
    padding: 0;
    background: #fff;
    color: #202124;
    overflow: hidden;
  }
  body {
    font: 14px/1.6 Arial, Helvetica, sans-serif;
    overflow-wrap: break-word;
  }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  pre { white-space: pre-wrap; }
`

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

export function hasTrimmableHtml(html: string | null): boolean {
  if (html === null) return false
  return Boolean(sanitizeToTemplate(html)?.content.querySelector(TRIM_SELECTOR))
}

function makeSrcDoc(html: string, collapsed: boolean): string | null {
  const template = sanitizeToTemplate(html)
  if (!template) return null
  if (collapsed) {
    template.content.querySelectorAll<HTMLElement>(TRIM_SELECTOR).forEach((element) => {
      element.style.setProperty('display', 'none', 'important')
    })
  }

  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${RESET}${collapsed ? HIDE_TRIM : ''}</style></head><body>${template.innerHTML}</body></html>`
}

export function MessageBody({ bodyText, bodyHtml, expanded = false }: MessageBodyProps): React.JSX.Element {
  const [height, setHeight] = useState<number | null>(null)
  const [oversizedSrcDoc, setOversizedSrcDoc] = useState<string | null>(null)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const keyDocumentRef = useRef<Document | null>(null)
  const srcDoc = useMemo(
    () => (bodyHtml === null ? null : makeSrcDoc(bodyHtml, !expanded)),
    [bodyHtml, expanded]
  )

  const oversized = srcDoc !== null && oversizedSrcDoc === srcDoc

  const measure = useCallback(
    (frame: HTMLIFrameElement) => {
      const doc = frame.contentDocument
      if (!doc?.body) return
      const scrollHeight = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight, 1)
      if (scrollHeight > MAX_SAFE_BODY_HEIGHT) {
        setOversizedSrcDoc(srcDoc)
        return
      }
      setHeight(Math.ceil(scrollHeight))
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

  useEffect(() => {
    setHeight(null)
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
    const visibleText = !expanded && trimIndex !== null ? bodyText.slice(0, trimIndex).trimEnd() : bodyText
    return (
      <div
        data-testid="plain-text-body"
        className="whitespace-pre-wrap leading-[1.6] text-ink [overflow-wrap:break-word]"
      >
        {visibleText}
      </div>
    )
  }

  return (
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
  )
}
