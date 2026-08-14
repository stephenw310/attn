import createDOMPurify, { type DOMPurify, type WindowLike } from 'dompurify'
import { sanitizeQuotedMailHtml } from '../../shared/mailSanitizer'

let purifier: DOMPurify | null = null

function quotePurifier(): DOMPurify {
  if (!purifier) {
    // Keep the large parser and its DOM out of main-process startup. Both load
    // only when a reply or forward actually needs quote sanitization.
    const { JSDOM } = require('jsdom') as typeof import('jsdom')
    const sanitizerWindow = new JSDOM('').window as unknown as WindowLike
    purifier = createDOMPurify(sanitizerWindow)
  }
  return purifier
}

export function sanitizeQuoteHtml(html: string): string {
  return sanitizeQuotedMailHtml(quotePurifier(), html).trim()
}
