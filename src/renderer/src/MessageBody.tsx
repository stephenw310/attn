import DOMPurify from 'dompurify'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { MessageAttachment } from '../../shared/mail'
import {
  MAIL_CID_SOURCE_MARKER as CID_SOURCE_MARKER,
  MAIL_IMAGE_PENDING_MARKER as IMAGE_PENDING_MARKER,
  sanitizeMailHtml,
  MAIL_TRIM_MARKER as TRIM_MARKER
} from '../../shared/mailSanitizer'
import type { ThemeAppearance } from '../../shared/theme'
import { forceLightMailCss } from './mailCss'
import {
  type InlineImageReference,
  matchInlineImageReferences,
  normalizedContentId
} from './mailInlineImages'
import { linkifyBareMailUrls, mailTextParts } from './mailLinks'
import {
  type MailLayout,
  type MailSurface,
  normalizeNativeMailBackgrounds,
  normalizeNativeMailDocument
} from './mailSurface'
import { findSignatureLineIndex, findTrimIndex } from './mailTrim'

interface MessageBodyProps {
  bodyText: string
  bodyHtml: string | null
  surface: MailSurface
  layout: MailLayout
  appearance: ThemeAppearance
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
const TRIM_COLLAPSED_ATTRIBUTE = 'data-attn-trim-collapsed'
const EMPTY_IMAGES = new Map<string, string>()
const attn = window.attn

function frameReset(surface: MailSurface, layout: MailLayout, appearance: ThemeAppearance): string {
  const senderCanvas = surface === 'light'
  const light = senderCanvas || appearance === 'light'
  return `
  :root { color-scheme: only ${light ? 'light' : 'dark'}; }
  html, body {
    margin: 0;
    padding: 0;
    background: ${senderCanvas ? '#fff' : 'transparent'};
    color: ${light ? '#202124' : '#e9eaee'};
  }
  html { overflow-x: auto; overflow-y: hidden; }
  body { overflow: visible; }
  body {
    font: ${light ? '14px/1.6 Arial, Helvetica, sans-serif' : '15px/1.7 Arial, Helvetica, sans-serif'};
    overflow-wrap: break-word;
    box-sizing: border-box;
    padding: 0;
  }
  ${
    senderCanvas && layout === 'centered'
      ? `#attn-mail-body#attn-mail-body {
    width: fit-content !important;
    max-width: 100% !important;
    margin-inline: auto !important;
  }`
      : ''
  }
  ${
    senderCanvas
      ? ''
      : `
  #attn-mail-root#attn-mail-root,
  #attn-mail-body#attn-mail-body,
  #attn-mail-body#attn-mail-body :where(*) {
    background-color: transparent !important;
    background-image: none !important;
  }`
  }
  ${
    light
      ? ''
      : `
  #attn-mail-body :is(blockquote, .gmail_quote) {
    color: #9da2ac;
  }
  #attn-mail-body a {
    color: #60a5fa !important;
  }`
  }
  img { max-width: 100%; height: auto; }
  img[${IMAGE_PENDING_MARKER}] { visibility: hidden !important; }
  table { max-width: 100%; }
  pre { white-space: pre-wrap; }
  [${TRIM_MARKER}] {
    display: block !important;
    height: ${TRIM_CONTROL_HEIGHT}px !important;
  }
  html[${TRIM_COLLAPSED_ATTRIBUTE}] [${TRIM_MARKER}] {
    height: calc(${TRIM_CONTROL_HEIGHT}px + var(--attn-trim-scrollbar-height, 0px)) !important;
  }
`
}

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

function hasRenderableContentBefore(content: DocumentFragment, boundary: Node): boolean {
  const range = document.createRange()
  range.setStart(content, 0)
  range.setEndBefore(boundary)
  return hasRenderableContent(range.cloneContents())
}

function wholeLineSignatureContainer(text: Text): Node {
  if (text.data.includes('\n')) return text
  let boundary: Node = text
  let parent = text.parentElement
  while (parent && parent.textContent === text.data) {
    boundary = parent
    parent = parent.parentElement
  }
  return boundary
}

function findHtmlTrimStart(content: DocumentFragment): Node | null {
  const walker = document.createTreeWalker(content, 5)
  let current = walker.nextNode()
  while (current) {
    if (current instanceof Element && current.matches(TRIM_SELECTOR)) return current
    if (current instanceof Text && !current.parentElement?.closest(`${TRIM_SELECTOR}, a, style, title`)) {
      const signatureIndex = findSignatureLineIndex(current.data)
      if (signatureIndex !== null) {
        return signatureIndex === 0 ? wholeLineSignatureContainer(current) : current.splitText(signatureIndex)
      }
    }
    current = walker.nextNode()
  }
  return null
}

function sanitizeToTemplate(
  html: string,
  surface: MailSurface,
  appearance: ThemeAppearance
): HTMLTemplateElement | null {
  if (!html.trim()) return null
  const clean = sanitizeMailHtml(DOMPurify, html)

  const template = document.createElement('template')
  template.innerHTML = clean
  template.content.querySelectorAll('style').forEach((style) => {
    const frozen = freezeViewportHeightUnits(style.textContent ?? '')
    style.textContent = surface === 'light' || appearance === 'light' ? forceLightMailCss(frozen) : frozen
  })
  template.content.querySelectorAll<HTMLElement>('[style]').forEach((element) => {
    element.setAttribute('style', freezeViewportHeightUnits(element.getAttribute('style') ?? ''))
  })
  if (surface === 'native') {
    if (appearance === 'dark') normalizeNativeMailDocument(template.content)
    else normalizeNativeMailBackgrounds(template.content)
  }
  template.content.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((link) => {
    const normalizedHref = normalizeMailLink(link.getAttribute('href') ?? '')
    if (normalizedHref === null) link.removeAttribute('href')
    else link.setAttribute('href', normalizedHref)
  })
  linkifyBareMailUrls(template.content)
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

function cidReferences(html: string): InlineImageReference[] {
  if (!/cid:/i.test(html)) return []
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  return [...parsed.querySelectorAll<HTMLImageElement>('img[src]')].flatMap((image) => {
    const source = image.getAttribute('src')?.trim() ?? ''
    if (!source.toLowerCase().startsWith('cid:')) return []
    const filenameHint = image.getAttribute('alt')?.trim()
    return [
      {
        contentId: normalizedContentId(source.slice(4)),
        ...(filenameHint ? { filenameHint } : {})
      }
    ]
  })
}

function makeSrcDoc(
  html: string,
  inlineImages: ReadonlyMap<string, string>,
  surface: MailSurface,
  layout: MailLayout,
  appearance: ThemeAppearance
): string | null {
  const template = sanitizeToTemplate(html, surface, appearance)
  if (!template) return null
  replaceCidSources(template.content, inlineImages)
  template.content.querySelectorAll('img').forEach((image) => {
    image.setAttribute(IMAGE_PENDING_MARKER, '')
  })
  const trimMatch = findHtmlTrimStart(template.content)
  const trimStart = trimMatch && hasRenderableContentBefore(template.content, trimMatch) ? trimMatch : null
  if (trimStart) {
    const marker = document.createElement('div')
    marker.setAttribute(TRIM_MARKER, '')
    trimStart.parentNode?.insertBefore(marker, trimStart)
  }
  const renderedAppearance = surface === 'light' ? 'light' : appearance
  return `<!doctype html><html id="attn-mail-root"><head><meta charset="utf-8"><meta name="color-scheme" content="${renderedAppearance}"><base target="_blank"><style>${frameReset(surface, layout, appearance)}</style></head><body id="attn-mail-body">${template.innerHTML}</body></html>`
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

/** Anything a mail frame could fetch over the network (T33 banner detection). */
const REMOTE_IMAGE_REFERENCE = /(?:src|srcset|poster|background)\s*=\s*["']?\s*https?:|url\(\s*["']?https?:/i

interface MailFrameAccess {
  /** The iframe's name; scripts are off in the frame, so markup can't change it. */
  nonce: string
  blocked: boolean
  imagesAllowed: boolean
}

export function MessageBody({
  bodyText,
  bodyHtml,
  surface,
  layout,
  appearance,
  threadId,
  messageId,
  attachments,
  expanded = false,
  onToggleTrim
}: MessageBodyProps): React.JSX.Element {
  const [measuredFrame, setMeasuredFrame] = useState<FrameMeasurement | null>(null)
  const [oversizedSrcDoc, setOversizedSrcDoc] = useState<string | null>(null)
  // T33: the frame mounts only after main has registered it with the
  // request filter, so an allowed sender's images are never spuriously
  // cancelled by a race, and a blocked one fails closed.
  const [frameAccess, setFrameAccess] = useState<MailFrameAccess | null>(null)
  const [frameEpoch, setFrameEpoch] = useState(0)
  const allowOnceRef = useRef(false)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const keyDocumentRef = useRef<Document | null>(null)
  const inlineImagesRef = useRef<ReadonlyMap<string, string>>(EMPTY_IMAGES)
  const watchedImagesRef = useRef(new WeakSet<HTMLImageElement>())
  const srcDoc = useMemo(
    () => (bodyHtml === null ? null : makeSrcDoc(bodyHtml, EMPTY_IMAGES, surface, layout, appearance)),
    [appearance, bodyHtml, layout, surface]
  )

  const revealLoadedImages = useCallback((doc: Document) => {
    doc.querySelectorAll<HTMLImageElement>(`img[${IMAGE_PENDING_MARKER}]`).forEach((image) => {
      if (image.complete && image.naturalWidth > 0) {
        image.removeAttribute(IMAGE_PENDING_MARKER)
        return
      }
      if (watchedImagesRef.current.has(image)) return
      watchedImagesRef.current.add(image)
      image.addEventListener(
        'load',
        () => {
          image.removeAttribute(IMAGE_PENDING_MARKER)
        },
        { once: true }
      )
    })
  }, [])

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
    revealLoadedImages(doc)
  }, [revealLoadedImages])

  useLayoutEffect(() => {
    inlineImagesRef.current = EMPTY_IMAGES
    if (bodyHtml === null || !attn) return
    const references = cidReferences(bodyHtml)
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

  useEffect(() => {
    setFrameAccess(null)
    if (srcDoc === null) return
    if (!attn) {
      // Unit and browser harnesses have no bridge and no request filter.
      setFrameAccess({ nonce: '', blocked: false, imagesAllowed: true })
      return
    }
    const nonce = crypto.randomUUID()
    // `Load once` is spent by exactly one registration (T33): the next mount
    // of this message is blocked again.
    const allowOnce = allowOnceRef.current
    allowOnceRef.current = false
    let stale = false
    attn.mail
      .registerMessageFrame(nonce, messageId, allowOnce)
      .then((access) => {
        if (!stale) setFrameAccess({ nonce, ...access })
      })
      .catch(() => {
        // Main's filter fails closed for an unregistered frame; the renderer
        // only loses the banner, never the protection.
        if (!stale) setFrameAccess({ nonce, blocked: false, imagesAllowed: true })
      })
    return () => {
      stale = true
      void attn.mail.unregisterMessageFrame(nonce).catch(() => {})
    }
  }, [frameEpoch, messageId, srcDoc])

  const hasRemoteImages = srcDoc !== null && REMOTE_IMAGE_REFERENCE.test(srcDoc)
  const remoteImagesBanner =
    frameAccess !== null && frameAccess.blocked && !frameAccess.imagesAllowed && hasRemoteImages
  const loadImagesOnce = useCallback(() => {
    allowOnceRef.current = true
    setFrameEpoch((epoch) => epoch + 1)
  }, [])
  const alwaysLoadFromSender = useCallback(() => {
    // The override's sender is resolved from the store in the utility; the
    // re-registration below picks the new answer up.
    void attn?.mail
      .allowRemoteImagesFromSender(messageId)
      .then(() => setFrameEpoch((epoch) => epoch + 1))
      .catch(() => {})
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
    (frame: HTMLIFrameElement) => {
      const doc = frame.contentDocument
      if (!doc?.body) return
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
    [expanded, srcDoc]
  )

  const forwardKey = useCallback((event: KeyboardEvent) => {
    const paletteShortcut =
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      !event.shiftKey &&
      event.key.toLocaleLowerCase() === 'k'
    if ((event.metaKey || event.ctrlKey || event.altKey) && !paletteShortcut) return
    // Tab owns focus traversal inside the mail document. Forwarding it to the
    // app would prevent the browser from moving through links in the message.
    if (event.key === 'Tab') return
    const target = event.target as HTMLElement | null
    // Enter on a focused link or control belongs to that element, not the
    // reader's convenient Reply-all alias.
    if (event.key === 'Enter' && target?.closest?.('a, button, input, textarea, select')) return
    const forwarded = new KeyboardEvent('keydown', {
      key: event.key,
      code: event.code,
      repeat: event.repeat,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
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
      revealLoadedImages(doc)
      measure(frame)
      const observer = new ResizeObserver(() => measure(frame))
      observer.observe(doc.body)
      observerRef.current = observer
      doc.addEventListener('keydown', forwardKey)
      keyDocumentRef.current = doc
    },
    [applyInlineImages, disconnect, forwardKey, measure, revealLoadedImages]
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
    const lightSurface = surface === 'light'
    const surfaceClass = lightSurface ? 'p-3 text-mail-light-ink' : 'text-ink'
    const trimIndex = findTrimIndex(bodyText)
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
          className={`mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-1.5 text-xs ${
            surface === 'light'
              ? 'border-mail-light-ink-dim/30 text-mail-light-ink-dim'
              : 'border-edge text-ink-faint'
          }`}
        >
          <span>Remote images blocked</span>
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
          <iframe
            key={frameAccess.nonce}
            name={frameAccess.nonce}
            ref={frameRef}
            data-testid="html-body-frame"
            title="HTML message body"
            sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
            srcDoc={srcDoc}
            onLoad={onLoad}
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
