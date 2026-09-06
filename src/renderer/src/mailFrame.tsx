import DOMPurify from 'dompurify'
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { safeUrl } from '../../shared/html'
import {
  MAIL_CID_SOURCE_MARKER,
  MAIL_IMAGE_PENDING_MARKER,
  MAIL_TRIM_MARKER,
  sanitizeMailHtml
} from '../../shared/mailSanitizer'
import type { ThemeAppearance } from '../../shared/theme'
import { normalizeAppleMailLineBackgrounds } from './mailAppleBackgrounds'
import { type InlineImageReference, normalizedContentId, TRANSPARENT_IMAGE } from './mailInlineImages'
import { linkifyBareMailUrls } from './mailLinks'
import { findHtmlTrimStart, hasRenderableContent, hasRenderableContentBefore } from './mailReading'
import { suppressBlockedRemoteImages } from './mailRemoteContent'
import {
  forceLightMailCss,
  type MailLayout,
  type MailSurface,
  normalizeNativeMailBackgrounds,
  normalizeNativeMailDocument
} from './mailSurface'
import scrollbarCss from './scrollbars.css?raw'

/**
 * One mail frame — the shell its untrusted document is wrapped in, the
 * registration that decides its remote-image policy, and the iframe that
 * measures it (review R5). The reader, the composer's quoted history, its
 * preserved-region preview and its inline images each grew their own copy of
 * this; three of them also grew their own `about:srcdoc` shell, and only the
 * newest carried a CSP.
 */

export const MAIL_TRIM_COLLAPSED_ATTRIBUTE = 'data-attn-trim-collapsed'
export const MAIL_TRIM_CONTROL_HEIGHT = 28

const MAIL_VIEWPORT_HEIGHT = 800
const VIEWPORT_HEIGHT_UNIT = /(-?(?:\d+(?:\.\d+)?|\.\d+))(?:(?:d|l|s)?vh)\b/gi
/**
 * Scripts are impossible inside these frames already — no `allow-scripts`, and
 * the sanitizer admits no script element or handler. The policy is about the
 * classes of request sender markup can still start: they are confined to the
 * kinds mail legitimately uses, and main's request filter, which sees the
 * frame's registration, remains the authority on whether any of them may go
 * out at all.
 */
const MAIL_FRAME_CSP = [
  "default-src 'none'",
  'img-src data: http: https:',
  'media-src data: http: https:',
  'font-src data: http: https:',
  "style-src 'unsafe-inline' http: https:"
].join('; ')
/** Schemes main will actually open; a display link outside them is dropped. */
const DISPLAY_LINK_SCHEMES = ['https', 'http', 'mailto']

export interface MailFramePresentation {
  surface: MailSurface
  layout: MailLayout
  appearance: ThemeAppearance
  /**
   * Let the document scroll inside a frame whose height is capped — the
   * composer's quote and preserved-region boxes. The reader sizes its frame to
   * the whole document instead, and scrolling there would hide mail.
   */
  scrollable?: boolean
}

function frameReset({ surface, layout, appearance, scrollable }: MailFramePresentation): string {
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
  html { overflow-x: auto; overflow-y: ${scrollable ? 'auto' : 'hidden'}; }
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
  img[${MAIL_IMAGE_PENDING_MARKER}] { visibility: hidden !important; }
  img[data-remote-blocked="true"] { visibility: hidden !important; }
  table { max-width: 100%; }
  pre { white-space: pre-wrap; }
  [${MAIL_TRIM_MARKER}] {
    display: block !important;
    height: ${MAIL_TRIM_CONTROL_HEIGHT}px !important;
  }
  html[${MAIL_TRIM_COLLAPSED_ATTRIBUTE}] [${MAIL_TRIM_MARKER}] {
    height: calc(${MAIL_TRIM_CONTROL_HEIGHT}px + var(--attn-trim-scrollbar-height, 0px)) !important;
  }
`
}

/** Wrap prepared body markup in the one scriptless `about:srcdoc` shell. */
export function mailFrameShell(body: string, presentation: MailFramePresentation): string {
  const renderedAppearance = presentation.surface === 'light' ? 'light' : presentation.appearance
  return `<!doctype html><html id="attn-mail-root" data-theme-appearance="${renderedAppearance}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${MAIL_FRAME_CSP}"><meta name="color-scheme" content="${renderedAppearance}"><base target="_blank"><style>${frameReset(presentation)}${scrollbarCss}</style></head><body id="attn-mail-body">${body}</body></html>`
}

function freezeViewportHeightUnits(css: string): string {
  return css.replace(VIEWPORT_HEIGHT_UNIT, (_, rawValue: string) => {
    return `${(Number(rawValue) * MAIL_VIEWPORT_HEIGHT) / 100}px`
  })
}

function normalizeMailLink(href: string): string | null {
  const value = href.trim()
  if (!value) return null
  // An in-document fragment never leaves the frame.
  if (value.startsWith('#')) return value
  if (value.startsWith('//')) return safeUrl(`https:${value}`, DISPLAY_LINK_SCHEMES)
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) return safeUrl(value, DISPLAY_LINK_SCHEMES)
  if (/^(?:www\.)?[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+(?:[/?#]|$)/i.test(value)) {
    return safeUrl(`https://${value}`, DISPLAY_LINK_SCHEMES)
  }
  return null
}

function sanitizeToTemplate(
  html: string,
  { surface, appearance }: MailFramePresentation,
  viewOriginal: boolean
): HTMLTemplateElement | null {
  if (!html.trim()) return null
  const clean = sanitizeMailHtml(DOMPurify, html)

  const template = document.createElement('template')
  template.innerHTML = clean
  if (!viewOriginal) normalizeAppleMailLineBackgrounds(template.content)
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
      image.setAttribute(MAIL_CID_SOURCE_MARKER, source)
      image.removeAttribute('src')
    }
  })
}

/** The `cid:` references a message's HTML makes, for inline-image matching. */
export function mailCidReferences(html: string): InlineImageReference[] {
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

export interface MailFrameDocumentOptions {
  html: string
  presentation: MailFramePresentation
  /** Already-resolved CID images; the rest are marked and filled in on load. */
  inlineImages?: ReadonlyMap<string, string>
  /** Skip the Apple Mail paste-artifact cleanup (the reader's View original). */
  viewOriginal?: boolean
  /** Insert the reader's trim marker before quoted history and signature. */
  allowTrim?: boolean
  /**
   * Paint blocked remote images as an invisible placeholder instead of letting
   * main's filter cancel the request and leave a broken-image glyph. The reader
   * does not need this — every image starts hidden and only a loaded one is
   * revealed — but the composer's quote and preserved regions show the user
   * their own draft, where a visible gap reads as content loss.
   */
  blockRemoteImages?: boolean
}

const NO_INLINE_IMAGES: ReadonlyMap<string, string> = new Map()

/**
 * The one display pipeline: DOMPurify's mail policy, the light-canvas and
 * native-surface normalizations, link and CID rewriting, then the shell.
 * Returns null when nothing renderable survives, so a caller can fall back to
 * plain text.
 */
export function mailFrameDocument({
  html,
  presentation,
  inlineImages = NO_INLINE_IMAGES,
  viewOriginal = false,
  allowTrim = false,
  blockRemoteImages = false
}: MailFrameDocumentOptions): string | null {
  const template = sanitizeToTemplate(html, presentation, viewOriginal)
  if (!template) return null
  if (blockRemoteImages) suppressBlockedRemoteImages(template.content, TRANSPARENT_IMAGE)
  replaceCidSources(template.content, inlineImages)
  template.content.querySelectorAll('img').forEach((image) => {
    image.setAttribute(MAIL_IMAGE_PENDING_MARKER, '')
  })
  const trimMatch = allowTrim ? findHtmlTrimStart(template.content) : null
  const trimStart = trimMatch && hasRenderableContentBefore(template.content, trimMatch) ? trimMatch : null
  if (trimStart) {
    const marker = document.createElement('div')
    marker.setAttribute(MAIL_TRIM_MARKER, '')
    trimStart.parentNode?.insertBefore(marker, trimStart)
  }
  return mailFrameShell(template.innerHTML, presentation)
}

/** Fill in CID images that resolved after the frame loaded. */
export function applyResolvedCidImages(
  frameDocument: Document,
  inlineImages: ReadonlyMap<string, string>
): void {
  frameDocument.querySelectorAll<HTMLImageElement>(`img[${MAIL_CID_SOURCE_MARKER}]`).forEach((image) => {
    const source = image.getAttribute(MAIL_CID_SOURCE_MARKER)?.trim() ?? ''
    const dataUrl = inlineImages.get(normalizedContentId(source.slice(4)))
    if (!dataUrl) return
    image.setAttribute('src', dataUrl)
    image.removeAttribute(MAIL_CID_SOURCE_MARKER)
  })
  revealLoadedImages(frameDocument)
}

const watchedImages = new WeakSet<HTMLImageElement>()

/**
 * Every image starts hidden so a blocked or broken one shows no glyph. Reveal
 * the ones that actually arrived, and watch the rest for their load event.
 */
export function revealLoadedImages(frameDocument: Document): void {
  frameDocument.querySelectorAll<HTMLImageElement>(`img[${MAIL_IMAGE_PENDING_MARKER}]`).forEach((image) => {
    if (image.complete && image.naturalWidth > 0) {
      image.removeAttribute(MAIL_IMAGE_PENDING_MARKER)
      return
    }
    if (watchedImages.has(image)) return
    watchedImages.add(image)
    image.addEventListener(
      'load',
      () => {
        image.removeAttribute(MAIL_IMAGE_PENDING_MARKER)
      },
      { once: true }
    )
  })
}

export interface MailFrameAccess {
  /** The iframe's name; scripts are off in the frame, so markup can't change it. */
  nonce: string
  /** Whether remote-image blocking is in force for this registration. */
  blocked: boolean
  imagesAllowed: boolean
}

export interface MailFrameAccessState {
  /** Null until main has answered; nothing may mount before then (T33). */
  access: MailFrameAccess | null
  /** T33 "Load once": ask main to grant one render, then re-register. */
  loadOnce: () => void
}

/**
 * Register one mail frame with main's request filter and follow the policy.
 * A `messageId` resolves the sender, so an Always-load exception reaches a
 * reply's quoted history and preserved regions too; without one the frame
 * stays unnamed — which main's filter fails closed on — and only the global
 * toggle answers, for callers that paint outside a mail frame.
 */
export function useMailFrameAccess({
  messageId,
  enabled = true
}: {
  messageId: string | null
  enabled?: boolean
}): MailFrameAccessState {
  const [access, setAccess] = useState<MailFrameAccess | null>(null)
  const [epoch, setEpoch] = useState(0)
  // The nonce main granted one render to, minted by `loadOnce` before the
  // gesture crossed IPC so the re-registration below claims that exact grant.
  const grantedNonceRef = useRef<string | null>(null)

  // A policy change (the toggle or a per-sender override, from Settings, the
  // palette, or another open message) re-registers every mounted frame, so an
  // open message picks up its fresh answer without being reopened.
  useEffect(() => {
    const bridge = window.attn
    if (!bridge) return
    return bridge.mail.onRemoteImagesChanged(() => setEpoch((current) => current + 1))
  }, [])

  // biome-ignore lint/correctness/useExhaustiveDependencies: epoch deliberately re-registers the frame so "Load once" / "Always load" take effect on the same mount
  useEffect(() => {
    setAccess(null)
    if (!enabled) return
    const bridge = window.attn
    if (!bridge) {
      // Unit and browser harnesses have no bridge and so no request filter:
      // nothing is blocked because nothing is enforcing.
      setAccess({ nonce: '', blocked: false, imagesAllowed: true })
      return
    }
    let stale = false
    if (messageId === null) {
      void bridge.settings
        .getAll()
        .then(({ remoteImagesBlocked }) => {
          if (!stale) {
            setAccess({ nonce: '', blocked: remoteImagesBlocked, imagesAllowed: !remoteImagesBlocked })
          }
        })
        .catch(() => {
          if (!stale) setAccess({ nonce: '', blocked: true, imagesAllowed: false })
        })
      return () => {
        stale = true
      }
    }
    // `Load once` is spent by exactly one registration (T33): main matches
    // its grant to this nonce and message, so the next mount of this message —
    // which mints a fresh nonce — is blocked again.
    const nonce = grantedNonceRef.current ?? crypto.randomUUID()
    grantedNonceRef.current = null
    bridge.mail
      .registerMessageFrame(nonce, messageId)
      .then((answer) => {
        if (!stale) setAccess({ nonce, ...answer })
      })
      .catch(() => {
        // Iframes still fail closed in main when registration is absent. The
        // composer also consumes this answer from the unfiltered top frame, so
        // the renderer must keep its remote source behind the placeholder too.
        if (!stale) setAccess({ nonce, blocked: true, imagesAllowed: false })
      })
    return () => {
      stale = true
      void bridge.mail.unregisterMessageFrame(nonce).catch(() => {})
    }
  }, [enabled, epoch, messageId])

  const loadOnce = useCallback(() => {
    const bridge = window.attn
    if (!bridge || messageId === null) return
    // Report the gesture first: main records a single-use grant against the
    // nonce the remount will register, and only then does the frame
    // re-register (T33). Registration itself carries no allowance.
    const nonce = crypto.randomUUID()
    void bridge.mail
      .allowRemoteImagesOnce(nonce, messageId)
      .then(() => {
        grantedNonceRef.current = nonce
        setEpoch((current) => current + 1)
      })
      .catch(() => {})
  }, [messageId])

  return { access, loadOnce }
}

type IframeAttributes = Omit<
  React.IframeHTMLAttributes<HTMLIFrameElement>,
  'srcDoc' | 'sandbox' | 'name' | 'onLoad' | 'ref'
>

interface MailFrameProps extends IframeAttributes {
  access: MailFrameAccess
  srcDoc: string
  title: string
  /** Runs once per load, before the first measurement. */
  onFrameLoad?: (frameDocument: Document) => void
  /** Runs after each load and on every resize of the frame's body. */
  onMeasure: (frameDocument: Document, frame: HTMLIFrameElement) => void
  /** Optional handle for callers that reach into the frame between loads. */
  frameRef?: React.RefObject<HTMLIFrameElement | null>
}

/**
 * `allow-same-origin` is needed only to measure this scriptless srcdoc,
 * resolve CID images, and forward keyboard events to the app shell. The frame
 * mounts under the nonce main already registered, so an allowed sender's
 * images are never spuriously cancelled by a race, and a blocked one fails
 * closed.
 */
export function MailFrame({
  access,
  srcDoc,
  onFrameLoad,
  onMeasure,
  frameRef,
  ...iframeProps
}: MailFrameProps): React.JSX.Element {
  const localRef = useRef<HTMLIFrameElement | null>(null)
  const observerRef = useRef<ResizeObserver | null>(null)
  const keyDocumentRef = useRef<Document | null>(null)

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
    ;(localRef.current ?? document.body).dispatchEvent(forwarded)
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
      const frameDocument = frame.contentDocument
      if (!frameDocument?.body) return

      disconnect()
      onFrameLoad?.(frameDocument)
      revealLoadedImages(frameDocument)
      onMeasure(frameDocument, frame)
      const observer = new ResizeObserver(() => {
        const current = frame.contentDocument
        if (current?.body) onMeasure(current, frame)
      })
      observer.observe(frameDocument.body)
      observerRef.current = observer
      frameDocument.addEventListener('keydown', forwardKey)
      keyDocumentRef.current = frameDocument
    },
    [disconnect, forwardKey, onFrameLoad, onMeasure]
  )

  // `srcDoc` can be applied before the frame reports a load, so poll for the
  // document rather than trusting a single load event to arrive.
  useLayoutEffect(() => {
    if (!srcDoc) return
    let frameId = 0
    const waitForSrcDoc = (): void => {
      const frame = localRef.current
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

  return (
    <iframe
      key={access.nonce}
      name={access.nonce || undefined}
      ref={(element) => {
        localRef.current = element
        if (frameRef) frameRef.current = element
      }}
      sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      srcDoc={srcDoc}
      onLoad={(event) => {
        const frame = event.currentTarget
        frame.dataset.loadCount = String(Number(frame.dataset.loadCount ?? 0) + 1)
        observe(frame)
      }}
      {...iframeProps}
    />
  )
}
