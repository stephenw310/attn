import { findSignatureLineIndex } from './mailTrim'

const MEANINGFUL_ELEMENTS = 'img, picture, svg, table, hr, video, audio, canvas'
const TRIM_SELECTOR = '.gmail_quote, .gmail_signature_prefix, .gmail_signature, blockquote[type="cite"]'

export function hasRenderableContent(content: DocumentFragment): boolean {
  const visibleProbe = content.cloneNode(true) as DocumentFragment
  visibleProbe.querySelectorAll('style').forEach((style) => {
    style.remove()
  })
  return Boolean(visibleProbe.textContent?.trim()) || Boolean(visibleProbe.querySelector(MEANINGFUL_ELEMENTS))
}

export function hasRenderableContentBefore(content: DocumentFragment, boundary: Node): boolean {
  const range = document.createRange()
  range.setStart(content, 0)
  range.setEndBefore(boundary)
  return hasRenderableContent(range.cloneContents())
}

function wholeLineSignatureContainer(text: Text): Node {
  if (text.data.includes('\n')) return text
  let boundary: Node = text
  let parent = text.parentElement
  while (parent && parent.textContent === text.data) {
    boundary = parent
    parent = parent.parentElement
  }
  return boundary
}

export function findHtmlTrimStart(content: DocumentFragment): Node | null {
  const walker = document.createTreeWalker(content, 5)
  let current = walker.nextNode()
  while (current) {
    if (current instanceof Element && current.matches(TRIM_SELECTOR)) return current
    if (current instanceof Text && !current.parentElement?.closest(`${TRIM_SELECTOR}, a, style, title`)) {
      const signatureIndex = findSignatureLineIndex(current.data)
      if (signatureIndex !== null) {
        return signatureIndex === 0 ? wholeLineSignatureContainer(current) : current.splitText(signatureIndex)
      }
    }
    current = walker.nextNode()
  }
  return null
}
