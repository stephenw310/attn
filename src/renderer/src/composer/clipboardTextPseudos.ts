type TextStyle = Map<string, string>

/** Capture rendered text ranges before removing first-line and first-letter rules. */
export function snapshotTextPseudos(
  element: Element,
  line: TextStyle,
  letter: TextStyle,
  overrides?: Map<Element, Set<string>>
): () => void {
  if (!line.size && !letter.size) return () => {}
  const document = element.ownerDocument
  // Inline descendants inherit a first-line pseudo style but do not establish
  // their own first formatted line to capture a second time.
  if (document.defaultView?.getComputedStyle(element).display === 'inline') return () => {}
  const atomic = (node: Element) =>
    ['IMG', 'VIDEO', 'AUDIO', 'CANVAS', 'SVG', 'IFRAME', 'INPUT'].includes(node.tagName) ||
    ['inline-block', 'inline-flex', 'inline-grid', 'inline-table'].includes(
      document.defaultView?.getComputedStyle(node).display ?? ''
    )
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      for (let parent = node.parentElement; parent && parent !== element; parent = parent.parentElement)
        if (atomic(parent)) return NodeFilter.FILTER_REJECT
      if (node.nodeType === Node.ELEMENT_NODE) {
        const style = document.defaultView?.getComputedStyle(node as Element)
        if (
          style &&
          (style.display === 'none' ||
            ['absolute', 'fixed'].includes(style.position) ||
            style.float !== 'none')
        )
          return NodeFilter.FILTER_REJECT
      }
      return NodeFilter.FILTER_ACCEPT
    }
  })
  const runs: { range: Range; style: TextStyle }[] = []
  let firstRect: DOMRect | undefined
  let firstIsAtomic = false
  let letterState = 0
  const vertical = /^(?:vertical|sideways)/.test(
    document.defaultView?.getComputedStyle(element).writingMode ?? ''
  )
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  let pastLine = false
  while (walker.nextNode()) {
    if (walker.currentNode.nodeType === Node.ELEMENT_NODE) {
      if (atomic(walker.currentNode as Element) && (walker.currentNode as Element).getClientRects().length) {
        letterState = 2
        if (!firstRect) firstIsAtomic = true
        firstRect ??= [...(walker.currentNode as Element).getClientRects()].find(
          (rect) => rect.width > 0 && rect.height > 0
        )
      }
      if (
        (walker.currentNode as Element).tagName === 'BR' &&
        (walker.currentNode as Element).getClientRects().length
      ) {
        pastLine = true
        letterState = 2
      }
      continue
    }
    const node = walker.currentNode as Text
    if (node.parentElement?.closest('style, script')) continue
    for (const { segment: character, index: offset } of segmenter.segment(node.data)) {
      const end = offset + character.length
      const range = document.createRange()
      range.setStart(node, offset)
      range.setEnd(node, end)
      const rect = [...range.getClientRects()].find((rect) => rect.width > 0 && rect.height > 0)
      if (!rect) {
        continue
      }
      const isLetter = letterState < 2 && (letterState === 0 || /^\p{P}+$/u.test(character))
      const dropCap = isLetter && (letter.has('font-size') || letter.has('float'))
      if (!firstRect && !dropCap && !/\s/u.test(character)) firstRect = rect
      if (
        firstRect &&
        (vertical
          ? rect.left >= firstRect.right || rect.right <= firstRect.left
          : firstIsAtomic
            ? rect.top >= firstRect.bottom || rect.bottom <= firstRect.top
            : Math.abs(rect.bottom - firstRect.bottom) > Math.min(rect.height, firstRect.height) / 2)
      )
        pastLine = true
      if (firstIsAtomic && !pastLine) {
        firstRect = rect
        firstIsAtomic = false
      }
      const style = new Map(!pastLine ? line : [])
      if (node.parentElement && node.parentElement !== element) {
        const origin = document.defaultView?.getComputedStyle(element)
        const descendant = document.defaultView?.getComputedStyle(node.parentElement)
        for (const name of style.keys())
          if (descendant?.getPropertyValue(name) !== origin?.getPropertyValue(name)) style.delete(name)
        for (
          let parent: Element | null = node.parentElement;
          parent && parent !== element;
          parent = parent.parentElement
        )
          for (const name of overrides?.get(parent) ?? []) style.delete(name)
      }
      if (letterState === 1 && !/^\p{P}+$/u.test(character)) letterState = 2
      if (letterState < 2 && !/^\s+$/u.test(character)) {
        for (const [name, value] of letter) style.set(name, value)
        if (!/^\p{P}+$/u.test(character)) letterState = 1
      }
      if (style.size) {
        const previous = runs.at(-1)
        if (
          previous &&
          previous.range.endContainer === node &&
          previous.range.endOffset === offset &&
          previous.style.size === style.size &&
          [...style].every(([name, value]) => previous.style.get(name) === value)
        )
          previous.range.setEnd(node, end)
        else runs.push({ range, style })
      }
    }
  }
  return () => {
    for (const { range, style } of runs.reverse()) {
      const text = range.extractContents()
      const span = document.createElement('span')
      span.setAttribute('style', [...style].map(([name, value]) => `${name}:${value}`).join(';'))
      span.append(text)
      range.insertNode(span)
    }
  }
}
