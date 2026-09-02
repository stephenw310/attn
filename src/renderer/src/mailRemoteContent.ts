// T33 banner detection: does this sanitized mail document reference anything
// its frame could fetch over the network? The request filter in main blocks
// by type-independent policy, so the banner must recognize the same breadth —
// an SVG <image href>, a CSS url() or @import — or a deliberately blocked
// resource would offer no Load once / Always load recovery (PR #101 review).

const REMOTE_URL = /^\s*https?:/i
const CONTAINS_REMOTE_URL = /https?:\/\//i
const STYLE_REMOTE = /url\(\s*["']?\s*https?:|@import\s+["']https?:/i

/** Attributes whose value is one fetchable URL, on any element. */
const FETCH_ATTRIBUTES = ['src', 'poster', 'background'] as const
/** href fetches only on SVG image/use; anchors merely navigate. */
const SVG_HREF_TAGS = new Set(['image', 'use'])

export function isRemoteMailUrl(value: string): boolean {
  try {
    // Chromium's URL parser ignores ASCII whitespace inside a scheme. Use
    // that parser instead of a raw prefix so `ht\ntp:` cannot evade policy.
    const protocol = new URL(value, window.location.href).protocol.toLowerCase()
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Replace blocked remote image sources in a detached display document. The
 * original draft/quote HTML stays untouched; the transparent source prevents
 * Chromium's broken-image glyph while preserving any explicit dimensions.
 */
export function suppressBlockedRemoteImages(root: ParentNode, placeholder: string): void {
  for (const image of root.querySelectorAll<HTMLImageElement>('img')) {
    const source = image.getAttribute('src') ?? ''
    if (isRemoteMailUrl(source)) {
      image.setAttribute('src', placeholder)
      image.setAttribute('alt', '')
      image.setAttribute('data-remote-blocked', 'true')
    }
    const srcset = image.getAttribute('srcset') ?? ''
    if (CONTAINS_REMOTE_URL.test(srcset)) image.removeAttribute('srcset')
  }
}

export function containsRemoteMailContent(html: string): boolean {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  for (const element of doc.querySelectorAll('*')) {
    const tag = element.tagName.toLowerCase()
    if (tag === 'style') {
      if (STYLE_REMOTE.test(element.textContent ?? '')) return true
      continue
    }
    for (const name of FETCH_ATTRIBUTES) {
      const value = element.getAttribute(name)
      if (value && REMOTE_URL.test(value)) return true
    }
    const srcset = element.getAttribute('srcset')
    if (srcset && CONTAINS_REMOTE_URL.test(srcset)) return true
    if (SVG_HREF_TAGS.has(tag)) {
      const href = element.getAttribute('href') ?? element.getAttribute('xlink:href')
      if (href && REMOTE_URL.test(href)) return true
    }
    const style = element.getAttribute('style')
    if (style && STYLE_REMOTE.test(style)) return true
  }
  return false
}
