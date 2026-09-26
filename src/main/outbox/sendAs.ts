import { createHash } from 'node:crypto'
import { isValidEmail, normalizeEmailKey } from '../../shared/address'
import type { DraftSaveInput, SendAsIdentity } from '../../shared/drafts'
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
    The gray is a fixed mid tone so recipients and both themes read it as
    secondary; the marker attribute is what identity survives on. */
const ATTN_FOOTER_HTML =
  '<div data-attn-signature="footer"><br><span style="color:#888888">Sent with ' +
  `<a href="${ATTN_SIGNATURE_URL}" style="color:#888888;text-decoration:underline">Attn</a></span></div>`
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
  // Gmail leaves the primary name empty whenever it uses the Google profile
  // name, so this runs on every send-as refresh for those accounts. Drive it
  // from the SENT thread index rather than scanning every message the account
  // has ever stored: `thread_labels` holds the union of its messages' labels,
  // so it is a superset of the threads that can hold a SENT message, and the
  // per-message `labels_json` test below stays the authority.
  const row = db
    .prepare(
      `SELECT m.from_name
       FROM thread_labels tl
       JOIN messages m ON m.account_id = tl.account_id AND m.thread_id = tl.thread_id
       WHERE tl.account_id = ? AND tl.label_id = 'SENT'
         AND lower(m.from_email) = lower(?)
         AND m.labels_json LIKE '%"SENT"%' AND trim(COALESCE(m.from_name, '')) <> ''
         AND lower(trim(m.from_name)) <> ?
       ORDER BY m.internal_date DESC
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
  // The cache is only ever written by signatureBody below, so an unchanged
  // source means the stored pair is exactly what rebuilding would produce.
  const signature: DraftSignature =
    cachedSource === source && cachedHtml !== undefined && cachedText !== undefined
      ? { bodyHtml: cachedHtml, bodyText: cachedText }
      : signatureBody(source)
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
  provider: Pick<MailProvider, 'getSendAs' | 'listSendAs'>,
  options?: ProviderRequestOptions
): Promise<ProviderSendAs | null> {
  if (provider.listSendAs) {
    const identities = await provider.listSendAs(options)
    cacheSendAsIdentities(db, accountId, identities)
    const primary = identities.find(
      (identity) => normalizeEmailKey(identity.sendAsEmail) === normalizeEmailKey(accountId)
    )
    if (primary) cachePrimarySendAs(db, accountId, primary)
    return primary ?? null
  }
  if (!provider.getSendAs) return null
  const sendAs = await provider.getSendAs(accountId, options)
  cachePrimarySendAs(db, accountId, sendAs)
  return sendAs
}

function cachedPrimarySignature(db: Db, accountId: string): DraftSignature | null {
  const bodyHtml = readAccountSetting(db, accountId, SEND_AS_SIGNATURE_HTML_SETTING)
  if (!bodyHtml) return null
  // Both halves are written together in one transaction.
  return { bodyHtml, bodyText: readAccountSetting(db, accountId, SEND_AS_SIGNATURE_TEXT_SETTING) ?? '' }
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
  const identities = cachedSendAsIdentities(db, accountId)
  const identity =
    identities.find((item) => item.sendAsEmail === draft.senderEmail) ??
    identities.find((item) => item.isDefault) ??
    identities[0]
  draft = { ...draft, senderEmail: draft.senderEmail ?? identity.sendAsEmail }
  if (draft.bodyHtml.trim() || draft.bodyText.trim()) {
    return { draft, defaultSignatureFingerprint: null }
  }
  const signature = identity.isPrimary
    ? cachedPrimarySignature(db, accountId)
    : identity.signature
      ? signatureBody(identity.signature)
      : null
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
  return documentFingerprint(new JSDOM(bodyHtml).window.document)
}

function documentFingerprint(document: Document): string | null {
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
  const key = `${defaultSignatureFingerprint}\u0000${createHash('sha256').update(draft.bodyHtml).digest('hex')}`
  const remembered = untouchedSignatureCache.get(key)
  if (remembered !== undefined) return remembered
  const { JSDOM } = require('jsdom') as typeof import('jsdom')
  const currentDocument = new JSDOM(draft.bodyHtml).window.document
  // The stored fingerprint decides which regions the baseline had; comparing
  // against it also catches a deleted footer or signature (the draft is then
  // an authored edit, and its removal is never undone by reinsertion).
  const untouched =
    !hasContentOutsideSignature(currentDocument) &&
    documentFingerprint(currentDocument) === defaultSignatureFingerprint
  rememberUntouchedSignature(key, untouched)
  return untouched
}

/**
 * Pure in (body HTML, stored fingerprint), pure out — and every Drafts and
 * search read asks it again for rows that have not changed. Remembering the
 * answer keeps `listDrafts` off the DOM parser entirely on a warm read (P6).
 */
const UNTOUCHED_SIGNATURE_CACHE_LIMIT = 128
const untouchedSignatureCache = new Map<string, boolean>()

function rememberUntouchedSignature(key: string, untouched: boolean): void {
  untouchedSignatureCache.set(key, untouched)
  if (untouchedSignatureCache.size <= UNTOUCHED_SIGNATURE_CACHE_LIMIT) return
  const oldest = untouchedSignatureCache.keys().next()
  if (!oldest.done) untouchedSignatureCache.delete(oldest.value)
}

const SEND_AS_IDENTITIES_SETTING = 'sendAsIdentities'

export function cacheSendAsIdentities(db: Db, accountId: string, identities: ProviderSendAs[]): void {
  const accepted = identities
    .filter(
      (identity) =>
        isValidEmail(identity.sendAsEmail) &&
        (normalizeEmailKey(identity.sendAsEmail) === normalizeEmailKey(accountId) ||
          identity.verificationStatus === 'accepted')
    )
    .map((identity) => ({
      sendAsEmail: identity.sendAsEmail,
      displayName: identity.displayName ?? '',
      replyToAddress:
        identity.replyToAddress && isValidEmail(identity.replyToAddress)
          ? identity.replyToAddress
          : undefined,
      isPrimary: normalizeEmailKey(identity.sendAsEmail) === normalizeEmailKey(accountId),
      isDefault: identity.isDefault === true,
      signature: sanitizeQuoteHtml(identity.signature ?? '')
    }))
  writeAccountSetting(db, accountId, SEND_AS_IDENTITIES_SETTING, JSON.stringify(accepted))
}

export function cachedSendAsIdentities(db: Db, accountId: string): ProviderSendAs[] {
  const raw = readAccountSetting(db, accountId, SEND_AS_IDENTITIES_SETTING)
  const identities: ProviderSendAs[] = raw ? JSON.parse(raw) : []
  if (
    !identities.some((identity) => normalizeEmailKey(identity.sendAsEmail) === normalizeEmailKey(accountId))
  ) {
    identities.unshift({
      sendAsEmail: accountId,
      isPrimary: true,
      displayName: readAccountSetting(db, accountId, SEND_AS_DISPLAY_NAME_SETTING) ?? ''
    })
  }
  return identities
}

export function publicSendAsIdentities(db: Db, accountId: string): SendAsIdentity[] {
  return cachedSendAsIdentities(db, accountId).map(
    ({ signature: _signature, verificationStatus: _status, ...identity }) => identity
  )
}

export class SendAsUnavailableError extends Error {
  constructor() {
    super('This sender is no longer available. Choose a verified From address.')
    this.name = 'SendAsUnavailableError'
  }
}

export function resolveSendAs(db: Db, accountId: string, email: string): ProviderSendAs {
  const identity = cachedSendAsIdentities(db, accountId).find(
    (item) => normalizeEmailKey(item.sendAsEmail) === normalizeEmailKey(email)
  )
  if (!identity) throw new SendAsUnavailableError()
  return identity
}
