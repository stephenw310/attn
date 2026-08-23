export type MailSurface = 'native' | 'light'
export type MailLayout = 'padded' | 'full-bleed'

export interface MailPresentation {
  surface: MailSurface
  layout: MailLayout
}

const SIGNATURE = '.gmail_signature_prefix, .gmail_signature'
const QUOTED_MAIL = '.gmail_quote, blockquote[type="cite"]'
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
    normalized === 'rgba(255,255,255,0)' ||
    normalized === 'rgba(0,0,0,0)'
  )
}

function styleHasCanvas(style: CSSStyleDeclaration): boolean {
  const image = style.getPropertyValue('background-image').trim().toLowerCase()
  if (image && image !== 'none') return true
  const color = style.getPropertyValue('background-color').trim()
  if (color && !isNeutralCanvas(color)) return true
  const background = style.getPropertyValue('background').trim()
  return Boolean(background && background.toLowerCase() !== 'none' && !isNeutralCanvas(background))
}

interface ParsedStyleRule {
  selector: string
  declarations: string
}

function topLevelStyleRules(css: string): ParsedStyleRule[] {
  const rules: ParsedStyleRule[] = []
  let preludeStart = 0
  let blockStart = -1
  let depth = 0
  let parentheses = 0
  let quote: string | null = null
  let escaped = false

  for (let index = 0; index < css.length; index += 1) {
    const character = css[index]
    if (escaped) {
      escaped = false
      continue
    }
    if (character === '\\') {
      escaped = true
      continue
    }
    if (quote) {
      if (character === quote) quote = null
      continue
    }
    if (character === '"' || character === "'") {
      quote = character
      continue
    }
    if (character === '(') {
      parentheses += 1
      continue
    }
    if (character === ')') {
      parentheses = Math.max(0, parentheses - 1)
      continue
    }
    if (parentheses > 0) continue
    if (character === ';' && depth === 0) {
      preludeStart = index + 1
      continue
    }
    if (character === '{') {
      if (depth === 0) blockStart = index
      depth += 1
      continue
    }
    if (character !== '}' || depth === 0) continue
    depth -= 1
    if (depth !== 0 || blockStart < 0) continue

    const selector = css.slice(preludeStart, blockStart).trim()
    if (selector && !selector.startsWith('@')) {
      rules.push({ selector, declarations: css.slice(blockStart + 1, index) })
    }
    preludeStart = index + 1
    blockStart = -1
  }

  return rules
}

function matchingStyleDeclarations(document: Document, element: Element): CSSStyleDeclaration[] {
  const declarations: CSSStyleDeclaration[] = []
  for (const style of document.querySelectorAll('style')) {
    const css = (style.textContent ?? '').replace(/\/\*[\s\S]*?\*\//g, '')
    for (const rule of topLevelStyleRules(css)) {
      try {
        if (!element.matches(rule.selector)) continue
      } catch {
        continue
      }
      const probe = document.createElement('div')
      probe.setAttribute('style', rule.declarations)
      declarations.push(probe.style)
    }
  }
  return declarations
}

function declaresCanvas(style: CSSStyleDeclaration): boolean {
  for (let index = 0; index < style.length; index += 1) {
    const property = style.item(index)
    if (property === 'background' || property === 'background-color' || property === 'background-image') {
      return true
    }
  }
  return false
}

function stylesheetCanvas(document: Document, element: Element): boolean | null {
  const canvasRules = matchingStyleDeclarations(document, element).filter(declaresCanvas)
  if (canvasRules.length === 0) return null
  // Multiple matching canvas rules require the real cascade and media state to
  // resolve safely. Keep padding when the static classifier cannot prove which wins.
  return canvasRules.length === 1 && styleHasCanvas(canvasRules[0])
}

function elementOwnsCanvas(document: Document, element: HTMLElement): boolean {
  if (declaresCanvas(element.style)) return styleHasCanvas(element.style)
  const stylesheet = stylesheetCanvas(document, element)
  if (stylesheet !== null) return stylesheet
  const background = element.getAttribute('background')?.trim()
  if (background) return true
  const bgcolor = element.getAttribute('bgcolor')?.trim()
  if (bgcolor && !isNeutralCanvas(bgcolor)) return true
  return false
}

function spansDocument(element: HTMLElement): boolean {
  const width = (element.style.width || element.getAttribute('width') || '').toLowerCase().replace(/\s/g, '')
  return width === '100%'
}

function nonZeroMargin(value: string): boolean {
  const normalized = value.trim().toLowerCase()
  return Boolean(normalized && normalized !== 'auto' && !/^0(?:[a-z%]+)?$/.test(normalized))
}

function constrainsNaturalWidth(style: CSSStyleDeclaration): boolean {
  const width = style.width.trim().toLowerCase().replace(/\s/g, '')
  if (width && width !== 'auto' && width !== '100%') return true
  const maxWidth = style.maxWidth.trim().toLowerCase().replace(/\s/g, '')
  if (maxWidth && maxWidth !== 'none' && maxWidth !== '100%') return true
  const display = style.display.trim().toLowerCase()
  if (display.startsWith('inline') || display === 'contents') return true
  const float = style.float.trim().toLowerCase()
  if (float && float !== 'none') return true
  return nonZeroMargin(style.marginLeft) || nonZeroMargin(style.marginRight)
}

function hasWidthConstraint(document: Document, element: HTMLElement): boolean {
  return (
    constrainsNaturalWidth(element.style) ||
    matchingStyleDeclarations(document, element).some(constrainsNaturalWidth)
  )
}

const NATURAL_FULL_WIDTH = new Set(['DIV', 'SECTION', 'MAIN', 'ARTICLE', 'HEADER', 'FOOTER'])
const NON_CONTENT = new Set(['STYLE', 'LINK', 'META', 'TITLE', 'SCRIPT'])

function ownsOuterCanvas(document: Document): boolean {
  // DOMPurify sanitizes mail as a fragment, so inline styles and legacy canvas
  // attributes on the source html/body wrappers do not reach the iframe. Only
  // stylesheet rules targeting the reconstructed wrappers survive sanitization.
  if (
    stylesheetCanvas(document, document.documentElement) === true ||
    stylesheetCanvas(document, document.body) === true
  ) {
    return true
  }

  const hasDirectText = [...document.body.childNodes].some((node) => {
    return node.nodeType === 3 && Boolean(node.textContent?.trim())
  })
  if (hasDirectText) return false
  const content = [...document.body.children].filter((element) => !NON_CONTENT.has(element.tagName))
  if (content.length !== 1) return false
  const outer = content[0] as HTMLElement
  const fullWidth =
    !hasWidthConstraint(document, outer) && (NATURAL_FULL_WIDTH.has(outer.tagName) || spansDocument(outer))
  if (!fullWidth) return false
  if (elementOwnsCanvas(document, outer)) return true

  if (outer.tagName !== 'TABLE' || !spansDocument(outer)) return false
  const firstCell = outer.querySelector<HTMLElement>(':scope > tbody > tr > td, :scope > tr > td')
  return firstCell ? elementOwnsCanvas(document, firstCell) : false
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

function hasPresentationMarkup(root: Element): boolean {
  if (root.querySelector(RICH_CONTENT)) return true
  return [...root.querySelectorAll<HTMLElement>('[style]')].some(hasPresentationStyle)
}

/**
 * Text-like HTML belongs on Attn's native surface. Presentation HTML keeps a
 * light document canvas so its inherited colours, tables, and media render as
 * the sender designed them. A *decorative* signature or quoted trail does not
 * turn an otherwise plain message into a newsletter — but a forward carries the
 * whole original message inside its quote, and that is content, not decoration.
 * Ignoring it renders a newsletter on the dark surface with its canvas stripped.
 */
export function mailPresentationForHtml(html: string | null): MailPresentation {
  if (!html?.trim()) return { surface: 'native', layout: 'padded' }
  const document = new DOMParser().parseFromString(html, 'text/html')
  // Signatures are decorative by definition. Dropping them first is what lets a
  // quoted trail whose only richness is a signature logo still read as plain.
  document.querySelectorAll(SIGNATURE).forEach((element) => {
    element.remove()
  })
  // Judge quoted mail before removing it — a forwarded document keeps its own
  // <style> and tables inside the quote, so removing it first destroys the
  // evidence. The quote element itself may carry the canvas (bgcolor, width).
  const quoted = [...document.querySelectorAll(QUOTED_MAIL)]
  const richQuote = quoted.some((element) => element.matches(RICH_CONTENT) || hasPresentationMarkup(element))
  for (const element of quoted) element.remove()
  const surface =
    richQuote || document.querySelector('style') || hasPresentationMarkup(document.body) ? 'light' : 'native'
  const layout = surface === 'light' && ownsOuterCanvas(document) ? 'full-bleed' : 'padded'
  return { surface, layout }
}

export function mailSurfaceForHtml(html: string | null): MailSurface {
  return mailPresentationForHtml(html).surface
}
