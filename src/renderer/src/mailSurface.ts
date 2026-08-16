export type MailSurface = 'native' | 'light'

const TRAILING_MAIL = '.gmail_quote, .gmail_signature_prefix, .gmail_signature, blockquote[type="cite"]'
const RICH_CONTENT = [
  'style',
  'table',
  'img',
  'picture',
  'svg',
  'canvas',
  'video',
  'audio',
  'center',
  'font',
  '[bgcolor]',
  '[background]',
  '[width]',
  '[height]',
  '[align]',
  '[valign]'
].join(', ')

const NATIVE_STYLE_PROPERTIES = new Set([
  'color',
  'direction',
  'font',
  'font-family',
  'font-feature-settings',
  'font-size',
  'font-style',
  'font-variant',
  'font-weight',
  'letter-spacing',
  'line-height',
  'text-align',
  'text-decoration',
  'text-indent',
  'text-transform',
  'white-space',
  'word-spacing'
])

function isNeutralCanvas(value: string): boolean {
  const normalized = value.toLowerCase().replace(/\s+/g, '')
  return (
    normalized === 'transparent' ||
    normalized === 'white' ||
    normalized === '#fff' ||
    normalized === '#ffffff' ||
    normalized === 'rgb(255,255,255)' ||
    normalized === 'rgba(255,255,255,1)' ||
    normalized === 'rgba(255,255,255,0)'
  )
}

function styleDeclarations(style: string): { property: string; value: string; raw: string }[] {
  return style.split(';').flatMap((raw) => {
    const separator = raw.indexOf(':')
    if (separator <= 0) return []
    const property = raw
      .slice(0, separator)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\s/g, '')
      .toLowerCase()
    return [{ property, value: raw.slice(separator + 1).trim(), raw: raw.trim() }]
  })
}

function hasPresentationStyle(element: HTMLElement): boolean {
  for (const { property, value } of styleDeclarations(element.getAttribute('style') ?? '')) {
    if (NATIVE_STYLE_PROPERTIES.has(property)) continue
    if ((property === 'background' || property === 'background-color') && isNeutralCanvas(value)) {
      continue
    }
    return true
  }
  return false
}

/** Remove sender canvases from content classified for Attn's native dark surface. */
export function normalizeNativeMailDocument(root: ParentNode): void {
  root.querySelectorAll('style').forEach((style) => {
    style.remove()
  })
  root.querySelectorAll<HTMLElement>('[bgcolor], [background], [style]').forEach((element) => {
    element.removeAttribute('bgcolor')
    element.removeAttribute('background')
    const style = styleDeclarations(element.getAttribute('style') ?? '')
      .filter(({ property }) => !property.startsWith('background'))
      .map(({ raw }) => raw)
      .join('; ')
    if (style) element.setAttribute('style', style)
    else element.removeAttribute('style')
  })
}

/**
 * Text-like HTML belongs on Attn's native surface. Presentation HTML keeps a
 * light document canvas so its inherited colours, tables, and media render as
 * the sender designed them. A decorative signature or quoted trail does not
 * turn an otherwise plain message into a newsletter.
 */
export function mailSurfaceForHtml(html: string | null): MailSurface {
  if (!html?.trim()) return 'native'
  const document = new DOMParser().parseFromString(html, 'text/html')
  document.querySelectorAll(TRAILING_MAIL).forEach((element) => {
    element.remove()
  })
  if (document.querySelector('style') || document.body.querySelector(RICH_CONTENT)) return 'light'
  return [...document.body.querySelectorAll<HTMLElement>('[style]')].some(hasPresentationStyle)
    ? 'light'
    : 'native'
}
