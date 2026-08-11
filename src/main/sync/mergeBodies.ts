import { textFromRaw } from '../gmail/parse'

interface MergeExternalBodiesInput {
  storedText: string | null
  storedHtml: string | null
  inlineText: string
  hasInlinePlain: boolean
  fetchedPlain: string[]
  fetchedHtml: string[]
}

export interface MergedBodies {
  bodyText: string | null
  bodyHtml: string | null
}

/** Merge fetched out-of-line MIME parts without degrading an authored plain-text alternative. */
export function mergeExternalBodies({
  storedText,
  storedHtml,
  inlineText,
  hasInlinePlain,
  fetchedPlain,
  fetchedHtml
}: MergeExternalBodiesInput): MergedBodies {
  const bodyHtml =
    fetchedHtml.length > 0 ? [storedHtml, ...fetchedHtml].filter(Boolean).join('\n') : storedHtml
  let bodyText = storedText

  if (fetchedPlain.length > 0) {
    const authoredParts = hasInlinePlain ? [inlineText, ...fetchedPlain] : fetchedPlain
    bodyText = textFromRaw('text/plain', authoredParts.filter(Boolean).join('\n\n'))
  } else if (fetchedHtml.length > 0 && !storedText) {
    bodyText = textFromRaw('text/html', bodyHtml ?? '')
  }

  return { bodyText, bodyHtml }
}
