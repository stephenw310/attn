import { isRgbColor } from '../../shared/css'

// Chromium serializes the WebKit alias as the unprefixed property.
const LINE_PROPERTIES = new Set(['-webkit-text-size-adjust', 'text-size-adjust', 'background-color'])
const TEXT_PROPERTIES = new Set([
  'color',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'text-decoration',
  'text-decoration-line'
])
const INLINE_TAGS = new Set(['SPAN', 'A', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'BR', 'FONT'])
// The artifact's own two colours, read through the shared colour parser so a
// different but equivalent serialization still matches (review R8).
const APPLE_DARK_LINE = { red: 58, green: 58, blue: 60 }

function hasWhiteBackground(element: HTMLElement): boolean {
  const value = element.style.backgroundColor
  return value === 'white' || isRgbColor(value, 255, 255, 255)
}

function appleLineSpan(line: HTMLElement): HTMLElement | null {
  if (
    line.closest('table') ||
    (line.style.getPropertyValue('text-size-adjust') ||
      line.style.getPropertyValue('-webkit-text-size-adjust')) !== 'auto' ||
    !isRgbColor(
      line.style.backgroundColor,
      APPLE_DARK_LINE.red,
      APPLE_DARK_LINE.green,
      APPLE_DARK_LINE.blue
    ) ||
    line.hasAttribute('bgcolor') ||
    line.hasAttribute('background') ||
    Array.from(line.style).some((property) => !LINE_PROPERTIES.has(property)) ||
    line.children.length !== 1
  ) {
    return null
  }
  const span = line.firstElementChild as HTMLElement
  if (
    span.tagName !== 'SPAN' ||
    !hasWhiteBackground(span) ||
    [...line.childNodes].some((node) => node !== span && Boolean(node.textContent?.trim()))
  ) {
    return null
  }
  const content = [span, ...span.querySelectorAll<HTMLElement>('*')]
  if (
    content.some(
      (element) =>
        !INLINE_TAGS.has(element.tagName) ||
        element.hasAttribute('bgcolor') ||
        element.hasAttribute('background') ||
        Array.from(element.style).some(
          (property) =>
            !TEXT_PROPERTIES.has(property) &&
            !(property === 'background-color' && hasWhiteBackground(element))
        )
    )
  ) {
    return null
  }
  return span
}

function hasAncestorBackground(line: HTMLElement): boolean {
  for (let parent = line.parentElement; parent; parent = parent.parentElement) {
    if (
      parent.hasAttribute('bgcolor') ||
      parent.hasAttribute('background') ||
      Array.from(parent.style).some((property) => property.startsWith('background'))
    ) {
      return true
    }
  }
  return false
}

/** Clean a repeated Apple Mail paste artifact in a display copy, never stored or outgoing HTML. */
export function normalizeAppleMailLineBackgrounds(root: ParentNode): void {
  // Stylesheets may make these same elements part of a deliberate design.
  if (root.querySelector('style')) return
  const groups = new Map<ParentNode, { line: HTMLElement; span: HTMLElement }[]>()
  for (const line of root.querySelectorAll<HTMLElement>('div[style]')) {
    const span = appleLineSpan(line)
    if (!span || !line.parentNode || hasAncestorBackground(line)) continue
    const group = groups.get(line.parentNode) ?? []
    group.push({ line, span })
    groups.set(line.parentNode, group)
  }
  for (const group of groups.values()) {
    // A single highlighted line is ambiguous. Blank spacer lines do not count.
    if (group.filter(({ span }) => span.textContent?.trim()).length < 2) continue
    for (const { line, span } of group) {
      line.style.removeProperty('background-color')
      for (const element of [span, ...span.querySelectorAll<HTMLElement>('[style]')]) {
        element.style.removeProperty('background-color')
      }
    }
  }
}
