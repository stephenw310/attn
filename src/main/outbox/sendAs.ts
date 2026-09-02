import { createHash } from 'node:crypto'
import type { DraftSaveInput } from '../../shared/drafts'
import { ATTN_SIGNATURE_LINE, ATTN_SIGNATURE_URL } from '../../shared/settings'
import type { Db } from '../db'
import { textFromRaw } from '../gmail/parse'
import { readAccountSetting, writeAccountSetting } from '../settings'
import type { MailProvider, ProviderRequestOptions, ProviderSendAs } from '../sync/provider'
import { sanitizeQuoteHtml } from './quoteSanitizer'

export const SEND_AS_DISPLAY_NAME_SETTING = 'sendAsDisplayName'
export const SEND_AS_SIGNATURE_SOURCE_SETTING = 'sendAsSignatureSource'
export const SEND_AS_SIGNATURE_HTML_SETTING = 'sendAsSignatureHtml'
export const SEND_AS_SIGNATURE_TEXT_SETTING = 'sendAsSignatureText'
export const ATTN_SIGNATURE_SETTING = 'attnSignatureEnabled'

/** The footer element the composer's AttnFooterNode round-trips (F6/T32B).
    The gray is a fixed mid tone so recipients and all four themes read it as
    secondary; the marker attribute is what identity survives on. */
const ATTN_FOOTER_HTML =
  '<div data-attn-signature="footer"><br><span style="color:#888888">Sent with ' +
  `<a href="${ATTN_SIGNATURE_URL}" style="color:#888888;text-decoration:underline">Attn:</a></span></div>`
const ATTN_FOOTER_SELECTOR = '[data-attn-signature="footer"]'

export function attnSignatureEnabled(db: Db, accountId: string): boolean {
  const stored = readAccountSetting(db, accountId, ATTN_SIGNATURE_SETTING)
  return stored === undefined || stored === 'true'
}

export interface DraftSignature {
  bodyHtml: string
  bodyText: string
}

export interface PreparedPrimarySignatureDraft {
  draft: DraftSaveInput
  defaultSignatureFingerprint: string | null
}

function hasCurrentSignatureEnvelope(bodyHtml: string): boolean {
  const { JSDOM } = require('jsdom') as typeof import('jsdom')
  const document = new JSDOM(bodyHtml).window.document
  const root = document.body.firstElementChild
  const signature = document.querySelector('.gmail_signature[data-smartmail="gmail_signature"]')
  return (
    root?.tagName === 'DIV' &&
    root.getAttribute('dir') === 'ltr' &&
    signature?.getAttribute('dir') === 'ltr' &&
    signature.parentElement?.tagName === 'DIV' &&
    signature.parentElement.parentElement === root &&
    signature.parentElement.children.length === 1
  )
}

function signatureBody(rawHtml: string): DraftSignature {
  // Gmail's API omits its separator/quote-position checkbox. Do not guess it
  // or add a "-- " line that is absent from the returned signature HTML.
  const sanitized = sanitizeQuoteHtml(rawHtml).trim()
  if (!sanitized) return { bodyHtml: '', bodyText: '' }
  const text = textFromRaw('text/html', sanitized)
  return {
    bodyHtml: `<div dir="ltr"><div><br></div><div><div dir="ltr" class="gmail_signature" data-smartmail="gmail_signature">${sanitized}</div></div></div>`,
    bodyText: text ? `\n${text}` : ''
  }
}

/** Gmail leaves the primary send-as name empty when it uses the Google profile name. */
export function primarySenderDisplayName(
  db: Db,
  accountId: string,
  sendAsDisplayName?: string | null
): string {
  const explicit = sendAsDisplayName?.trim()
  if (explicit) return explicit

  const localPart = accountId.slice(0, accountId.indexOf('@')).trim().toLowerCase()
  const row = db
    .prepare(
      `SELECT from_name
       FROM messages
       WHERE account_id = ? AND lower(from_email) = lower(?)
         AND labels_json LIKE '%"SENT"%' AND trim(COALESCE(from_name, '')) <> ''
         AND lower(trim(from_name)) <> ?
       ORDER BY internal_date DESC
       LIMIT 1`
    )
    .get(accountId, accountId, localPart) as { from_name: string } | undefined
  if (row) return row.from_name.trim()

  return readAccountSetting(db, accountId, SEND_AS_DISPLAY_NAME_SETTING)?.trim() ?? ''
}

export function cachePrimarySendAs(db: Db, accountId: string, sendAs: ProviderSendAs): DraftSignature {
  const source = sendAs.signature ?? ''
  const displayName = primarySenderDisplayName(db, accountId, sendAs.displayName)
  const cachedSource = readAccountSetting(db, accountId, SEND_AS_SIGNATURE_SOURCE_SETTING)
  const cachedHtml = readAccountSetting(db, accountId, SEND_AS_SIGNATURE_HTML_SETTING)
  const cachedText = readAccountSetting(db, accountId, SEND_AS_SIGNATURE_TEXT_SETTING)
  let signature: DraftSignature
  if (
    cachedSource === source &&
    cachedHtml !== undefined &&
    cachedText !== undefined &&
    (source ? hasCurrentSignatureEnvelope(cachedHtml) : cachedHtml === '' && cachedText === '')
  ) {
    signature = { bodyHtml: cachedHtml, bodyText: cachedText }
  } else {
    signature = signatureBody(source)
  }
  db.transaction(() => {
    writeAccountSetting(db, accountId, SEND_AS_DISPLAY_NAME_SETTING, displayName)
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

/** Does the signature already end in the exact standalone footer line? Quoted
    history is never inspected for this deduplication (F6). */
function signatureContainsFooterLine(signatureHtml: string): boolean {
  const { JSDOM } = require('jsdom') as typeof import('jsdom')
  const document = new JSDOM(signatureHtml).window.document
  const signature = signatureElement(document.body)
  if (!signature) return false
  return textFromRaw('text/html', signature.innerHTML)
    .split('\n')
    .some((line) => line.trim() === ATTN_SIGNATURE_LINE)
}

/** Append a visibly separated footer after the signature wrapper, inside the body envelope. */
function withAttnFooter(signature: DraftSignature | null): DraftSignature {
  if (!signature) {
    return {
      bodyHtml: `<div dir="ltr"><div><br></div>${ATTN_FOOTER_HTML}</div>`,
      bodyText: `\n\n${ATTN_SIGNATURE_LINE}`
    }
  }
  const { JSDOM } = require('jsdom') as typeof import('jsdom')
  const document = new JSDOM(signature.bodyHtml).window.document
  const root = document.body.firstElementChild
  if (root?.tagName === 'DIV') root.insertAdjacentHTML('beforeend', ATTN_FOOTER_HTML)
  else document.body.insertAdjacentHTML('beforeend', ATTN_FOOTER_HTML)
  return {
    bodyHtml: document.body.innerHTML,
    bodyText: `${signature.bodyText}\n\n${ATTN_SIGNATURE_LINE}`
  }
}

/**
 * Apply the account's insertion defaults — the cached primary signature and,
 * when enabled, the "Sent with Attn" footer — to an empty composer of any
 * kind (F6). Defaults apply only here, at local draft creation: reopen,
 * import, autosave, mirror, send, retry, and undo never call this, so a
 * setting change leaves existing drafts exactly as saved, and a deleted
 * footer is never reinserted. The cache itself is never mutated.
 */
export function prepareDraftWithCachedPrimarySignature(
  db: Db,
  accountId: string,
  draft: DraftSaveInput
): PreparedPrimarySignatureDraft {
  if (draft.bodyHtml.trim() || draft.bodyText.trim()) {
    return { draft, defaultSignatureFingerprint: null }
  }
  const signature = cachedPrimarySignature(db, accountId)
  const footerWanted = attnSignatureEnabled(db, accountId)
  if (!signature && !footerWanted) return { draft, defaultSignatureFingerprint: null }
  const applied =
    footerWanted && !(signature && signatureContainsFooterLine(signature.bodyHtml))
      ? withAttnFooter(signature)
      : (signature as DraftSignature)
  return {
    draft: { ...draft, bodyHtml: applied.bodyHtml, bodyText: applied.bodyText },
    defaultSignatureFingerprint: signatureFingerprint(applied.bodyHtml)
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

/**
 * Fingerprint the draft's insertion defaults. A signature-only body keeps the
 * original formula so every stored pre-footer fingerprint still verifies; a
 * body carrying the footer hashes both regions as one baseline (T32B).
 */
function signatureFingerprint(bodyHtml: string): string | null {
  const { JSDOM } = require('jsdom') as typeof import('jsdom')
  const document = new JSDOM(bodyHtml).window.document
  const signature = signatureElement(document.body)
  const footer = footerElement(document.body)
  if (!signature && !footer) return null
  if (!footer) {
    return createHash('sha256')
      .update(JSON.stringify(semantics(signature as Element)))
      .digest('hex')
  }
  return createHash('sha256')
    .update(
      JSON.stringify({
        signature: signature ? semantics(signature) : null,
        footer: semantics(footer)
      })
    )
    .digest('hex')
}

function signatureElement(root: ParentNode): Element | null {
  return root.querySelector('.gmail_signature, [data-smartmail="gmail_signature"]')
}

function footerElement(root: ParentNode): Element | null {
  return root.querySelector(ATTN_FOOTER_SELECTOR)
}

function hasContentOutsideSignature(document: Document): boolean {
  const body = document.body.cloneNode(true) as HTMLElement
  signatureElement(body)?.remove()
  footerElement(body)?.remove()
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
  if (!draft.bodyHtml.includes('gmail_signature') && !draft.bodyHtml.includes('data-attn-signature')) {
    return false
  }
  if (!defaultSignatureFingerprint) return false
  const { JSDOM } = require('jsdom') as typeof import('jsdom')
  const currentDocument = new JSDOM(draft.bodyHtml).window.document
  if (hasContentOutsideSignature(currentDocument)) return false
  // The stored fingerprint decides which regions the baseline had; comparing
  // against it also catches a deleted footer or signature (the draft is then
  // an authored edit, and its removal is never undone by reinsertion).
  return signatureFingerprint(draft.bodyHtml) === defaultSignatureFingerprint
}
