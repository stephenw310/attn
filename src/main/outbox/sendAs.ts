import { createHash } from 'node:crypto'
import type { DraftSaveInput } from '../../shared/drafts'
import type { Db } from '../db'
import { textFromRaw } from '../gmail/parse'
import { readAccountSetting, writeAccountSetting } from '../settings'
import type { MailProvider, ProviderRequestOptions, ProviderSendAs } from '../sync/provider'
import { sanitizeQuoteHtml } from './quoteSanitizer'

export const SEND_AS_DISPLAY_NAME_SETTING = 'sendAsDisplayName'
export const SEND_AS_SIGNATURE_SOURCE_SETTING = 'sendAsSignatureSource'
export const SEND_AS_SIGNATURE_HTML_SETTING = 'sendAsSignatureHtml'
export const SEND_AS_SIGNATURE_TEXT_SETTING = 'sendAsSignatureText'

export interface DraftSignature {
  bodyHtml: string
  bodyText: string
}

export interface PreparedPrimarySignatureDraft {
  draft: DraftSaveInput
  defaultSignatureFingerprint: string | null
}

function signatureBody(rawHtml: string): DraftSignature {
  const sanitized = sanitizeQuoteHtml(rawHtml).trim()
  if (!sanitized) return { bodyHtml: '', bodyText: '' }
  const text = textFromRaw('text/html', sanitized)
  return {
    bodyHtml: `<div><br></div><div class="gmail_signature" data-smartmail="gmail_signature">${sanitized}</div>`,
    bodyText: text ? `\n${text}` : ''
  }
}

export function cachePrimarySendAs(db: Db, accountId: string, sendAs: ProviderSendAs): DraftSignature {
  const source = sendAs.signature ?? ''
  const cachedSource = readAccountSetting(db, accountId, SEND_AS_SIGNATURE_SOURCE_SETTING)
  const cachedHtml = readAccountSetting(db, accountId, SEND_AS_SIGNATURE_HTML_SETTING)
  const cachedText = readAccountSetting(db, accountId, SEND_AS_SIGNATURE_TEXT_SETTING)
  const signature =
    cachedSource === source && cachedHtml !== undefined && cachedText !== undefined
      ? { bodyHtml: cachedHtml, bodyText: cachedText }
      : signatureBody(source)
  db.transaction(() => {
    writeAccountSetting(db, accountId, SEND_AS_DISPLAY_NAME_SETTING, sendAs.displayName?.trim() ?? '')
    writeAccountSetting(db, accountId, SEND_AS_SIGNATURE_SOURCE_SETTING, source)
    writeAccountSetting(db, accountId, SEND_AS_SIGNATURE_HTML_SETTING, signature.bodyHtml)
    writeAccountSetting(db, accountId, SEND_AS_SIGNATURE_TEXT_SETTING, signature.bodyText)
  })()
  return signature
}

export async function syncPrimarySendAs(
  db: Db,
  accountId: string,
  provider: Pick<MailProvider, 'getSendAs'>,
  options?: ProviderRequestOptions
): Promise<ProviderSendAs | null> {
  if (!provider.getSendAs) return null
  const sendAs = await provider.getSendAs(accountId, options)
  cachePrimarySendAs(db, accountId, sendAs)
  return sendAs
}

export function cachedPrimarySignature(db: Db, accountId: string): DraftSignature | null {
  const bodyHtml = readAccountSetting(db, accountId, SEND_AS_SIGNATURE_HTML_SETTING)
  if (!bodyHtml) return null
  return {
    bodyHtml,
    bodyText:
      readAccountSetting(db, accountId, SEND_AS_SIGNATURE_TEXT_SETTING) ?? textFromRaw('text/html', bodyHtml)
  }
}

/** Gmail exposes its saved signature as a new-mail default, not a reply/forward default. */
export function prepareDraftWithCachedPrimarySignature(
  db: Db,
  accountId: string,
  draft: DraftSaveInput
): PreparedPrimarySignatureDraft {
  if (draft.kind !== 'new' || draft.bodyHtml.trim() || draft.bodyText.trim()) {
    return { draft, defaultSignatureFingerprint: null }
  }
  const signature = cachedPrimarySignature(db, accountId)
  if (!signature) return { draft, defaultSignatureFingerprint: null }
  return {
    draft: { ...draft, bodyHtml: signature.bodyHtml, bodyText: signature.bodyText },
    defaultSignatureFingerprint: signatureFingerprint(signature.bodyHtml)
  }
}

interface SignatureSemantics {
  text: string
  links: { href: string; text: string }[]
  images: { src: string; alt: string }[]
  formatting: { text: string; context: string[]; styles: [string, string][] }[]
}

const TEXT_FORMATTING_PROPERTIES = new Set([
  'background-color',
  'color',
  'font-family',
  'font-size',
  'font-style',
  'font-weight',
  'line-height',
  'text-align',
  'text-decoration',
  'text-decoration-line'
])

const STRUCTURAL_FORMATTING_ELEMENTS = new Set([
  'blockquote',
  'li',
  'ol',
  'table',
  'tbody',
  'td',
  'tfoot',
  'th',
  'thead',
  'tr',
  'ul'
])

function normalizedStyleValue(document: Document, property: string, value: string): string {
  const raw = value.trim().replace(/\s*!important$/i, '')
  const probe = document.createElement('span')
  probe.style.setProperty(property, raw)
  const normalized = (probe.style.getPropertyValue(property) || raw).trim().replace(/\s+/g, ' ').toLowerCase()
  if (property === 'font-weight') {
    if (normalized === '700') return 'bold'
    if (normalized === '400') return 'normal'
  }
  if (property === 'text-decoration' || property === 'text-decoration-line') {
    return normalized.split(' ').sort().join(' ')
  }
  return normalized
}

function applyElementFormatting(styles: Map<string, string>, element: Element): void {
  switch (element.tagName.toLowerCase()) {
    case 'b':
    case 'strong':
      styles.set('font-weight', 'bold')
      break
    case 'i':
    case 'em':
      styles.set('font-style', 'italic')
      break
    case 'u':
      styles.set('text-decoration-line', 'underline')
      break
    case 's':
    case 'strike':
      styles.set('text-decoration-line', 'line-through')
      break
  }
  const direction = element.getAttribute('dir')?.trim().toLowerCase()
  if (direction) styles.set('direction', direction)
  for (const declaration of (element.getAttribute('style') ?? '').split(';')) {
    const separator = declaration.indexOf(':')
    if (separator <= 0) continue
    const property = declaration.slice(0, separator).trim().toLowerCase()
    if (!TEXT_FORMATTING_PROPERTIES.has(property)) continue
    styles.set(
      property,
      normalizedStyleValue(element.ownerDocument, property, declaration.slice(separator + 1))
    )
  }
}

function formattingSemantics(element: Element): SignatureSemantics['formatting'] {
  const runs: SignatureSemantics['formatting'] = []
  const document = element.ownerDocument
  const walker = document.createTreeWalker(element, document.defaultView?.NodeFilter.SHOW_TEXT ?? 4)
  while (walker.nextNode()) {
    const node = walker.currentNode as Text
    const text = node.data.replace(/\s+/g, ' ').trim()
    if (!text) continue
    const ancestors: Element[] = []
    let ancestor = node.parentElement
    while (ancestor) {
      ancestors.unshift(ancestor)
      if (ancestor === element) break
      ancestor = ancestor.parentElement
    }
    const styles = new Map<string, string>()
    for (const current of ancestors) applyElementFormatting(styles, current)
    runs.push({
      text,
      context: ancestors
        .map((current) => current.tagName.toLowerCase())
        .filter((tag) => STRUCTURAL_FORMATTING_ELEMENTS.has(tag)),
      styles: [...styles].sort(([left], [right]) => left.localeCompare(right))
    })
  }
  return runs
}

function semantics(element: Element): SignatureSemantics {
  return {
    text: textFromRaw('text/html', element.innerHTML),
    links: [...element.querySelectorAll<HTMLAnchorElement>('a[href]')].map((link) => ({
      href: link.getAttribute('href')?.trim() ?? '',
      text: link.textContent?.trim() ?? ''
    })),
    images: [...element.querySelectorAll<HTMLImageElement>('img[src]')].map((image) => ({
      src: image.getAttribute('src')?.trim() ?? '',
      alt: image.getAttribute('alt')?.trim() ?? ''
    })),
    formatting: formattingSemantics(element)
  }
}

function signatureFingerprint(bodyHtml: string): string | null {
  const { JSDOM } = require('jsdom') as typeof import('jsdom')
  const document = new JSDOM(bodyHtml).window.document
  const signature = signatureElement(document.body)
  if (!signature) return null
  return createHash('sha256')
    .update(JSON.stringify(semantics(signature)))
    .digest('hex')
}

function signatureElement(root: ParentNode): Element | null {
  return root.querySelector('.gmail_signature, [data-smartmail="gmail_signature"]')
}

function hasContentOutsideSignature(document: Document): boolean {
  const body = document.body.cloneNode(true) as HTMLElement
  const clonedSignature = signatureElement(body)
  clonedSignature?.remove()
  if (body.textContent?.trim()) return true
  return body.querySelector('img, table, hr, svg, video, audio, canvas') !== null
}

/**
 * Treat the untouched default as empty composer state without relying on Lexical's HTML serialization or
 * the mutable account cache. The fingerprint belongs to the signature inserted into this draft, so a
 * later Gmail settings refresh cannot reclassify it. Visible text, formatting, link targets, and images
 * must still match, so editing the signature turns it into authored content. HTML is authoritative because
 * Lexical's plain-text list markers differ from the text fallback derived from Gmail's HTML.
 */
export function hasOnlyDefaultPrimarySignature(
  draft: Pick<DraftSaveInput, 'kind' | 'bodyHtml' | 'bodyText'>,
  defaultSignatureFingerprint: string | null | undefined
): boolean {
  if (draft.kind !== 'new') return false
  if (!draft.bodyHtml.includes('gmail_signature')) return false
  if (!defaultSignatureFingerprint) return false
  const { JSDOM } = require('jsdom') as typeof import('jsdom')
  const currentDocument = new JSDOM(draft.bodyHtml).window.document
  const currentSignature = signatureElement(currentDocument.body)
  if (!currentSignature || hasContentOutsideSignature(currentDocument)) {
    return false
  }
  return (
    createHash('sha256')
      .update(JSON.stringify(semantics(currentSignature)))
      .digest('hex') === defaultSignatureFingerprint
  )
}
