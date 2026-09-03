import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { useEffect } from 'react'
import { COLLAPSED_GMAIL_SIGNATURE_SELECTOR, revealGmailSignature } from './GmailSignatureNode'

/**
 * Click or Enter on the collapsed signature reveals it. The node owns the
 * collapsed DOM contract; this owns the gesture that ends it, and keeps the
 * label in step with whether the quoted history is folded in behind it.
 */
export function CollapsedSignaturePlugin({
  includesQuote,
  onReveal
}: {
  includesQuote: boolean
  onReveal: () => void
}): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    const label = includesQuote ? 'Show signature and quoted history' : 'Show signature'
    const updateLabels = (): void => {
      for (const signature of editor
        .getRootElement()
        ?.querySelectorAll<HTMLElement>(COLLAPSED_GMAIL_SIGNATURE_SELECTOR) ?? []) {
        signature.setAttribute('aria-label', label)
        signature.setAttribute('title', label)
      }
    }
    const collapsedSignature = (target: EventTarget | null): HTMLElement | null =>
      target instanceof Element ? target.closest<HTMLElement>(COLLAPSED_GMAIL_SIGNATURE_SELECTOR) : null
    const revealFromClick = (event: MouseEvent): void => {
      const signature = collapsedSignature(event.target)
      if (!signature) return
      event.preventDefault()
      event.stopPropagation()
      revealGmailSignature(signature)
      onReveal()
    }
    const revealFromKeyboard = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' && event.key !== ' ') return
      const signature = collapsedSignature(event.target)
      if (!signature) return
      event.preventDefault()
      event.stopPropagation()
      revealGmailSignature(signature)
      onReveal()
    }

    const unregisterRoot = editor.registerRootListener((root, previous) => {
      previous?.removeEventListener('click', revealFromClick, true)
      previous?.removeEventListener('keydown', revealFromKeyboard, true)
      root?.addEventListener('click', revealFromClick, true)
      root?.addEventListener('keydown', revealFromKeyboard, true)
      updateLabels()
    })
    const unregisterUpdate = editor.registerUpdateListener(updateLabels)
    updateLabels()
    return () => {
      unregisterUpdate()
      unregisterRoot()
    }
  }, [editor, includesQuote, onReveal])
  return null
}
