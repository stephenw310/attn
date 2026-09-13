import createDOMPurify from 'dompurify'
import { COMPOSER_STYLE_PROPERTIES } from './sanitize'

/** Resolve clipboard CSS in a scriptless frame whose CSP blocks all resource loads. */
export function snapshotClipboardStyles(source: Document): void {
  const imageSources = [...source.querySelectorAll('img')].map((image) => image.getAttribute('src'))
  const host = document.createElement('iframe')
  host.setAttribute('sandbox', 'allow-same-origin')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = 'position:fixed;left:-100000px;top:0;width:800px;height:600px;visibility:hidden'
  document.body.append(host)
  try {
    const frame = host.contentDocument
    const view = host.contentWindow
    if (!frame || !view) throw new Error('Clipboard style snapshot is unavailable')
    const policy = frame.createElement('meta')
    policy.httpEquiv = 'Content-Security-Policy'
    policy.content = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'"
    frame.head.append(policy)
    // DOMPurify removes active markup before anything enters a browsing context.
    const safe = createDOMPurify(window).sanitize(source.documentElement.outerHTML, {
      FORCE_BODY: true,
      ADD_TAGS: ['style'],
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form'],
      FORBID_ATTR: ['src', 'srcset', 'poster', 'background']
    })
    const parsed = new DOMParser().parseFromString(safe, 'text/html')
    const sheets = [...parsed.querySelectorAll('style')].map((style) => style.textContent ?? '')
    for (const style of parsed.querySelectorAll('style')) style.remove()
    const originalElements = [...parsed.body.querySelectorAll<HTMLElement>('*')]
    const inline = originalElements.map((element) => element.getAttribute('style') ?? '')
    for (const element of originalElements) element.removeAttribute('style')
    frame.body.append(...[...parsed.body.childNodes].map((node) => frame.importNode(node, true)))
    const elements = [...frame.body.querySelectorAll<HTMLElement>('*')]
    const css = sheets.join('\n') + inline.join(';')
    const properties = [...COMPOSER_STYLE_PROPERTIES]
      .filter(
        (property) =>
          (property !== 'font' && !['width', 'height'].includes(property)) ||
          new RegExp(`(?:^|[;{\\s])${property}\\s*:`, 'i').test(css)
      )
      .filter((property) => property !== 'font')
    const read = (element: Element, pseudo?: string): Map<string, string> => {
      const computed = view.getComputedStyle(element, pseudo)
      return new Map(
        properties
          .filter(
            (property) =>
              !/^border(?!-spacing|-collapse)/.test(property) ||
              ['top', 'right', 'bottom', 'left'].some(
                (side) => parseFloat(computed.getPropertyValue(`border-${side}-width`)) > 0
              )
          )
          .map((property) => [property, computed.getPropertyValue(property)])
      )
    }
    const baseline = elements.map((element) => read(element))
    frame.body.setAttribute('style', source.body.getAttribute('style') ?? '')
    for (let index = 0; index < elements.length; index++) elements[index].setAttribute('style', inline[index])
    for (const css of sheets) {
      const style = frame.createElement('style')
      style.textContent = css
      frame.head.append(style)
    }
    // Read everything before changing the DOM so selectors and inheritance stay intact.
    const snapshots = elements.map((element) => ({
      style: read(element),
      before: {
        content: view.getComputedStyle(element, '::before').content,
        style: read(element, '::before')
      },
      after: { content: view.getComputedStyle(element, '::after').content, style: read(element, '::after') }
    }))
    const generatedText = (content: string): string => {
      const quoted = content.match(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g) ?? []
      return quoted
        .map((part) =>
          part
            .slice(1, -1)
            .replace(/\\([0-9a-f]{1,6})\s?|\\(.)/gi, (_match, hex: string | undefined, character: string) =>
              hex ? String.fromCodePoint(Math.min(parseInt(hex, 16) || 0xfffd, 0x10ffff)) : character
            )
        )
        .join('')
    }
    for (let index = 0; index < elements.length; index++) {
      const element = elements[index]
      const snapshot = snapshots[index]
      const style = [...snapshot.style].filter(
        ([name, value]) => value && value !== baseline[index].get(name)
      )
      element.setAttribute('style', style.map(([name, value]) => `${name}:${value}`).join(';'))
      for (const side of ['before', 'after'] as const) {
        const text = generatedText(snapshot[side].content)
        if (!text) continue
        const span = frame.createElement('span')
        span.textContent = text
        span.setAttribute(
          'style',
          [...snapshot[side].style]
            .filter(([name, value]) => value && value !== snapshot.style.get(name))
            .map(([name, value]) => `${name}:${value}`)
            .join(';')
        )
        if (side === 'before') element.prepend(span)
        else element.append(span)
      }
    }
    source.body.replaceChildren(...[...frame.body.childNodes].map((node) => source.importNode(node, true)))
    for (const [index, image] of [...source.body.querySelectorAll('img')].entries()) {
      const src = imageSources[index]
      if (src) image.setAttribute('src', src)
    }
    for (const style of source.querySelectorAll('style')) style.remove()
  } finally {
    host.remove()
  }
}
