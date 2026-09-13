type TextStyle = Map<string, string>

/** Capture rendered text ranges before removing first-line and first-letter rules. */
export function snapshotTextPseudos(element: Element, line: TextStyle, letter: TextStyle): () => void {
  if (!line.size && !letter.size) return () => {}
  const document = element.ownerDocument
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  const runs: { range: Range; style: TextStyle }[] = []
  let firstRect: DOMRect | undefined
  let firstLetter = false
  let pastLine = false
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    if (node.parentElement?.closest('style, script')) continue
    for (let offset = 0; offset < node.length; ) {
      const character = String.fromCodePoint(node.data.codePointAt(offset) ?? 0)
      const end = offset + character.length
      const range = document.createRange()
      range.setStart(node, offset)
      range.setEnd(node, end)
      const rect = [...range.getClientRects()].find((rect) => rect.width > 0 && rect.height > 0)
      if (!rect) {
        offset = end
        continue
      }
      if (!firstRect && !/\s/u.test(character)) firstRect = rect
      if (firstRect && (rect.top >= firstRect.bottom || rect.bottom <= firstRect.top)) pastLine = true
      const style = new Map(!pastLine && firstRect ? line : [])
      if (!firstLetter && !/\s/u.test(character)) {
        for (const [name, value] of letter) style.set(name, value)
        if (!/\p{P}/u.test(character)) firstLetter = true
      }
      if (style.size) runs.push({ range, style })
      offset = end
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
