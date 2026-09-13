import createDOMPurify from 'dompurify'
import { materializeGeneratedContent } from './clipboardGeneratedContent'
import { COMPOSER_STYLE_PROPERTIES, PRESERVED_STYLE_PROPERTIES } from './sanitize'

/** Resolve clipboard CSS in a scriptless frame whose CSP blocks all resource loads. */
export function snapshotClipboardStyles(source: Document): void {
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
    const purifier = createDOMPurify(window)
    purifier.addHook('uponSanitizeAttribute', (node, data) => {
      // Data attributes can supply visible attr() text; their whitespace matters.
      if (data.attrName.startsWith('data-'))
        data.attrValue = node.getAttribute(data.attrName) ?? data.attrValue
    })
    const safe = purifier.sanitize(source.documentElement.outerHTML, {
      FORCE_BODY: true,
      ADD_TAGS: ['style'],
      FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form']
    })
    const parsed = new DOMParser().parseFromString(safe, 'text/html')
    const sheets = [...parsed.querySelectorAll('style')].map((style) => style.textContent ?? '')
    for (const style of parsed.querySelectorAll('style')) style.remove()
    const originalElements = [parsed.body, ...parsed.body.querySelectorAll<HTMLElement>('*')]
    const inline = originalElements.map(
      (element, index) => (index === 0 ? source.body : element).getAttribute('style') ?? ''
    )
    for (const element of originalElements) element.removeAttribute('style')
    frame.body.append(...[...parsed.body.childNodes].map((node) => frame.importNode(node, true)))
    const elements = [frame.body, ...frame.body.querySelectorAll<HTMLElement>('*')]
    const css = sheets.join('\n') + inline.join(';')
    const properties = [...COMPOSER_STYLE_PROPERTIES, ...PRESERVED_STYLE_PROPERTIES]
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
          .filter((property) => property !== 'transform-origin' || computed.transform !== 'none')
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
    const pseudoBaseline = elements.map((element) => ({
      marker: read(element, '::marker'),
      before: read(element, '::before'),
      after: read(element, '::after')
    }))
    for (let index = 0; index < elements.length; index++) elements[index].setAttribute('style', inline[index])
    for (const css of sheets) {
      const style = frame.createElement('style')
      style.textContent = css
      frame.head.append(style)
    }
    // Read everything before changing the DOM so selectors and inheritance stay intact.
    const snapshots = elements.map((element) => ({
      style: read(element),
      marker: {
        content: view.getComputedStyle(element, '::marker').content,
        style: read(element, '::marker')
      },
      before: {
        content: view.getComputedStyle(element, '::before').content,
        style: read(element, '::before')
      },
      after: { content: view.getComputedStyle(element, '::after').content, style: read(element, '::after') }
    }))
    const generated = materializeGeneratedContent(frame.body, view)
    for (let index = 0; index < elements.length; index++) {
      const element = elements[index]
      const snapshot = snapshots[index]
      for (const name of element.getAttributeNames()) {
        if (
          name.startsWith('data-') &&
          !name.startsWith('data-attn-') &&
          !['data-smartmail', 'data-surl'].includes(name)
        )
          element.removeAttribute(name)
      }
      const style = [...snapshot.style].filter(
        ([name, value]) => value && value !== baseline[index].get(name)
      )
      element.setAttribute('style', style.map(([name, value]) => `${name}:${value}`).join(';'))
      for (const side of ['marker', 'before', 'after'] as const) {
        const text = generated.get(element)?.[side] ?? ''
        if (!text) continue
        const span = frame.createElement('span')
        span.textContent = text
        span.setAttribute(
          'style',
          [...snapshot[side].style]
            .filter(([name, value]) => value && value !== pseudoBaseline[index][side].get(name))
            .map(([name, value]) => `${name}:${value}`)
            .join(';')
        )
        span.style.whiteSpace = 'pre-wrap'
        if (side === 'marker') {
          element.style.listStyleType = 'none'
          element.prepend(span)
        } else if (side === 'before') element.prepend(span)
        else element.append(span)
      }
    }
    const children = [...frame.body.childNodes].map((node) => source.importNode(node, true))
    if (frame.body.getAttribute('style')?.trim()) {
      const wrapper = source.createElement('div')
      wrapper.setAttribute('style', frame.body.getAttribute('style') ?? '')
      wrapper.append(...children)
      source.body.replaceChildren(wrapper)
    } else source.body.replaceChildren(...children)
    for (const style of source.querySelectorAll('style')) style.remove()
  } finally {
    host.remove()
  }
}
