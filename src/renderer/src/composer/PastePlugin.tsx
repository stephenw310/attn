import { $generateNodesFromDOM } from '@lexical/html'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $insertNodes } from 'lexical'
import { useEffect } from 'react'
import type { Draft } from '../../../shared/drafts'
import { $createImageNode } from './nodes/ImageNode'
import { prepareHtmlForEditor } from './preserve'
import { preserveBlankLineBlocks } from './rootNodes'

function imageAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('image read failed'))
    reader.onload = () => resolve(String(reader.result).split(',', 2)[1] ?? '')
    reader.readAsDataURL(file)
  })
}

/**
 * Paste, in the two shapes that need more than Lexical's default: image files
 * and data-URL images become spooled inline attachments with a CID, and
 * foreign HTML goes through the import pass that freezes what the editor
 * cannot represent.
 */
export function PasteContentPlugin({
  draftId,
  onAttachment,
  onError,
  onPreservedContent
}: {
  draftId: string
  onAttachment: (attachment: Draft['attachments'][number]) => void
  onError: (message: string) => void
  onPreservedContent: () => void
}): null {
  const [editor] = useLexicalComposerContext()
  useEffect(() => {
    // One handler per effect run: Lexical calls the root listener with
    // `(null, previousRoot)` on unregister, so the function removed there must
    // be the one that was added, or every re-run leaves a paste handler behind.
    const onPaste = (event: ClipboardEvent): void => {
      const files = [...(event.clipboardData?.files ?? [])].filter((file) => file.type.startsWith('image/'))
      if (files.length > 0 && window.attn) {
        event.preventDefault()
        event.stopPropagation()
        void (async () => {
          for (const file of files) {
            try {
              const dataBase64 = await imageAsBase64(file)
              const { attachment, dataUrl } = await window.attn.draft.addInlineImage(draftId, {
                filename: file.name || 'pasted-image',
                mimeType: file.type,
                dataBase64
              })
              onAttachment(attachment)
              editor.update(() => {
                $insertNodes([$createImageNode(dataUrl, attachment.contentId ?? '', attachment.filename)])
              })
            } catch (error) {
              onError(error instanceof Error ? error.message : 'Could not paste image')
            }
          }
        })()
        return
      }

      const html = event.clipboardData?.getData('text/html') ?? ''
      if (!html) return
      event.preventDefault()
      event.stopPropagation()
      void (async () => {
        const prepared = prepareHtmlForEditor(html)
        if (prepared.issues.length > 0) onPreservedContent()
        const document = new DOMParser().parseFromString(prepared.html, 'text/html')
        preserveBlankLineBlocks(document)
        for (const image of document.querySelectorAll<HTMLImageElement>('img[src]')) {
          const source = image.getAttribute('src') ?? ''
          if (!source.toLowerCase().startsWith('data:')) continue
          const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([a-z0-9+/=\s]+)$/i.exec(source)
          if (!match || !window.attn) {
            image.remove()
            continue
          }
          try {
            const result = await window.attn.draft.addInlineImage(draftId, {
              filename: image.getAttribute('alt') || 'pasted-image',
              mimeType: match[1],
              dataBase64: match[2].replace(/\s/g, '')
            })
            onAttachment(result.attachment)
            image.setAttribute('src', result.dataUrl)
            image.setAttribute('data-attn-cid', result.attachment.contentId ?? '')
          } catch (error) {
            image.remove()
            onError(error instanceof Error ? error.message : 'Could not paste image')
          }
        }
        editor.update(() => $insertNodes($generateNodesFromDOM(editor, document)))
      })()
    }
    return editor.registerRootListener((root, previous) => {
      previous?.removeEventListener('paste', onPaste, true)
      root?.addEventListener('paste', onPaste, true)
    })
  }, [draftId, editor, onAttachment, onError, onPreservedContent])
  return null
}
