import createDOMPurify from 'dompurify'
import { materializeGeneratedContent } from './clipboardGeneratedContent'
import { COMPOSER_STYLE_PROPERTIES, PRESERVED_STYLE_PROPERTIES } from './sanitize'

/** Resolve clipboard CSS in a scriptless frame whose CSP blocks all resource loads. */
export function snapshotClipboardStyles(source: Document): void {
  const host = document.createElement('iframe')
  host.setAttribute('sandbox', 'allow-same-origin')
  host.setAttribute('aria-hidden', 'true')
  host.style.cssText = `position:fixed;left:-100000px;top:0;border:0;width:${window.innerWidth}px;height:${window.innerHeight}px;visibility:hidden`
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
    // FORCE_BODY sanitization flattens document wrappers. Keep their safe
    // attributes in the frame so selectors still see the original context.
    for (const [original, target] of [
      [source.documentElement, frame.documentElement],
      [source.body, frame.body]
    ]) {
      const probe = source.createElement('div')
      for (const attribute of [...original.attributes]) probe.setAttribute(attribute.name, attribute.value)
      const clean = new DOMParser().parseFromString(purifier.sanitize(probe.outerHTML), 'text/html').body
        .firstElementChild
      if (clean)
        for (const attribute of [...clean.attributes]) {
          if (attribute.name !== 'style') target.setAttribute(attribute.name, attribute.value)
        }
    }
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
    const rootBaseline = read(frame.documentElement)
    const baseline = elements.map((element) => read(element))
    const pseudoBaseline = elements.map((element) => ({
      marker: read(element, '::marker'),
      before: read(element, '::before'),
      after: read(element, '::after')
    }))
    for (let index = 0; index < elements.length; index++) elements[index].setAttribute('style', inline[index])
    frame.documentElement.setAttribute('style', source.documentElement.getAttribute('style') ?? '')
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
    const rootStyle = read(frame.documentElement)
    const desired = new Map<Element, Map<string, string>>([
      [frame.documentElement, rootStyle],
      ...elements.map((element, index) => [element, snapshots[index].style] as const)
    ])
    const inherited = new Set([
      'direction',
      'color',
      'font-family',
      'font-size',
      'font-weight',
      'font-style',
      'font-variant',
      'font-stretch',
      'line-height',
      'white-space',
      'text-align',
      'visibility',
      'letter-spacing',
      'word-spacing',
      'text-transform',
      'text-indent',
      'writing-mode',
      'text-orientation'
    ])
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
        ([name, value]) =>
          value &&
          (value !== baseline[index].get(name) ||
            (inherited.has(name) &&
              element.parentElement &&
              desired.get(element.parentElement)?.get(name) !== value))
      )
      element.setAttribute('style', style.map(([name, value]) => `${name}:${value}`).join(';'))
      for (const side of ['marker', 'before', 'after'] as const) {
        const parts = generated.get(element)?.[side] ?? []
        if (!parts.length || parts.every((part) => 'text' in part && !part.text)) continue
        const span = frame.createElement('span')
        if (parts.every((part) => 'text' in part) && parts[0]?.alt !== undefined) {
          span.setAttribute('role', 'img')
          span.setAttribute('aria-label', parts[0].alt)
        }
        for (const part of parts) {
          if ('text' in part) span.append(frame.createTextNode(part.text))
          else {
            const image = frame.createElement('img')
            image.setAttribute('src', part.src)
            image.setAttribute('alt', part.alt ?? '')
            span.append(image)
          }
        }
        span.setAttribute(
          'style',
          [...snapshot[side].style]
            .filter(
              ([name, value]) =>
                value &&
                (value !== pseudoBaseline[index][side].get(name) ||
                  (inherited.has(name) && snapshot.style.get(name) !== value))
            )
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
    const direction = frame.body.dir || frame.documentElement.dir
    const language = frame.body.lang || frame.documentElement.lang
    if (frame.body.getAttribute('style')?.trim() || direction || language) {
      const wrapper = source.createElement('div')
      wrapper.setAttribute('style', frame.body.getAttribute('style') ?? '')
      if (direction) wrapper.dir = direction
      if (language) wrapper.lang = language
      wrapper.append(...children)
      source.body.replaceChildren(wrapper)
    } else source.body.replaceChildren(...children)
    const rootChanges = [...rootStyle].filter(([name, value]) => value && value !== rootBaseline.get(name))
    if (rootChanges.length) {
      const wrapper = source.createElement('div')
      wrapper.setAttribute('style', rootChanges.map(([name, value]) => `${name}:${value}`).join(';'))
      wrapper.append(...source.body.childNodes)
      source.body.replaceChildren(wrapper)
    }
    for (const style of source.querySelectorAll('style')) style.remove()
  } finally {
    host.remove()
  }
}
