type TextStyle = Map<string, string>

/** Capture rendered text ranges before removing first-line and first-letter rules. */
export function snapshotTextPseudos(element: Element, line: TextStyle, letter: TextStyle): () => void {
  if (!line.size && !letter.size) return () => {}
  const document = element.ownerDocument
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  const runs: { range: Range; style: TextStyle }[] = []
  let firstRect: DOMRect | undefined
  let letterState = 0
  const vertical = /^(?:vertical|sideways)/.test(
    document.defaultView?.getComputedStyle(element).writingMode ?? ''
  )
  const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  let pastLine = false
  while (walker.nextNode()) {
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
      if (!firstRect && !/\s/u.test(character)) firstRect = rect
      if (
        firstRect &&
        (vertical
          ? rect.left >= firstRect.right || rect.right <= firstRect.left
          : rect.top >= firstRect.bottom || rect.bottom <= firstRect.top)
      )
        pastLine = true
      const style = new Map(!pastLine && firstRect ? line : [])
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
