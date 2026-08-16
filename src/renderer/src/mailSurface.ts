export type MailSurface = 'native' | 'light'

const TRAILING_MAIL = '.gmail_quote, .gmail_signature_prefix, .gmail_signature, blockquote[type="cite"]'
const RICH_CONTENT = [
  'style',
  'table',
  'img',
  'picture',
  'svg',
  'canvas',
  'video',
  'audio',
  'center',
  'font',
  '[style]',
  '[bgcolor]',
  '[background]',
  '[width]',
  '[height]',
  '[align]',
  '[valign]'
].join(', ')

/**
 * Text-like HTML belongs on Attn's native surface. Presentation HTML keeps a
 * light document canvas so its inherited colours, tables, and media render as
 * the sender designed them. A decorative signature or quoted trail does not
 * turn an otherwise plain message into a newsletter.
 */
export function mailSurfaceForHtml(html: string | null): MailSurface {
  if (!html?.trim()) return 'native'
  const document = new DOMParser().parseFromString(html, 'text/html')
  document.querySelectorAll(TRAILING_MAIL).forEach((element) => {
    element.remove()
  })
  return document.querySelector('style') || document.body.querySelector(RICH_CONTENT) ? 'light' : 'native'
}
