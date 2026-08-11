import DOMPurify from 'dompurify'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

interface MessageBodyProps {
  bodyText: string
  bodyHtml: string | null
}

const MAX_BODY_HEIGHT = 1600
const MEANINGFUL_ELEMENTS = 'img, picture, svg, table, hr, video, audio, canvas'

const RESET = `
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; background: #fff; color: #202124; }
  body {
    font: 14px/1.6 Arial, Helvetica, sans-serif;
    overflow-wrap: break-word;
  }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  pre { white-space: pre-wrap; }
`

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.nodeName !== 'A') return
  const link = node as HTMLAnchorElement
  link.setAttribute('target', '_blank')
  link.setAttribute('rel', 'noopener noreferrer')
})

function makeSrcDoc(html: string): string | null {
  if (!html.trim()) return null
  const clean = DOMPurify.sanitize(html, {
    FORBID_TAGS: ['form', 'input', 'button', 'select', 'textarea'],
    ADD_TAGS: ['style'],
    ADD_ATTR: ['target'],
    FORCE_BODY: true
  })

  const template = document.createElement('template')
  template.innerHTML = clean
  const visibleProbe = template.content.cloneNode(true) as DocumentFragment
  visibleProbe.querySelectorAll('style').forEach((style) => {
    style.remove()
  })
  const hasText = Boolean(visibleProbe.textContent?.trim())
  const hasRenderableElement = Boolean(template.content.querySelector(MEANINGFUL_ELEMENTS))
  if (!hasText && !hasRenderableElement) return null

  return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${RESET}</style></head><body>${clean}</body></html>`
}

export function MessageBody({ bodyText, bodyHtml }: MessageBodyProps): React.JSX.Element {
  const [height, setHeight] = useState(80)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const keyDocumentRef = useRef<Document | null>(null)
  const srcDoc = useMemo(() => (bodyHtml === null ? null : makeSrcDoc(bodyHtml)), [bodyHtml])

  const measure = useCallback((frame: HTMLIFrameElement) => {
    const doc = frame.contentDocument
    if (!doc?.body) return
    const scrollHeight = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight, 1)
    setHeight(Math.min(scrollHeight, MAX_BODY_HEIGHT))
  }, [])

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
    setHeight(80)
    if (srcDoc === null) return
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
  }, [disconnect, observe, srcDoc])

  if (srcDoc === null) {
    return (
      <div
        data-testid="plain-text-body"
        className="whitespace-pre-wrap leading-[1.6] text-ink [overflow-wrap:break-word]"
      >
        {bodyText}
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
      style={{ height, maxHeight: MAX_BODY_HEIGHT }}
    />
  )
}
