import createDOMPurify, { type WindowLike } from 'dompurify'
import { JSDOM } from 'jsdom'
import { sanitizeMailHtml } from '../../shared/mailSanitizer'

// T15 runs in the main process, which has no browser DOM. A single inert jsdom
// window gives DOMPurify the same standards-based parsing boundary as display.
const sanitizerWindow = new JSDOM('').window as unknown as WindowLike
const purifier = createDOMPurify(sanitizerWindow)

export function sanitizeQuoteHtml(html: string): string {
  return sanitizeMailHtml(purifier, html).trim()
}
