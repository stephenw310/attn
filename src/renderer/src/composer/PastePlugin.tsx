import { $generateNodesFromDOM } from '@lexical/html'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import {
  $getNodeByKey,
  $getSelection,
  $insertNodes,
  $isDecoratorNode,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  HISTORY_PUSH_TAG,
  type LexicalNode
} from 'lexical'
import { useEffect } from 'react'
import type { Draft } from '../../../shared/drafts'
import { createCommand, registerCommands } from '../commands'
import { normalizeClipboardHtml } from './clipboardHtml'
import { $insertPlainClipboardText } from './clipboardText'
import { $createImageNode } from './nodes/ImageNode'
import { $isProtectedComposerNode, $topLevelComposerNode } from './nodes/protected'
import { prepareHtmlForEditor } from './preserve'
import { preserveBlankLineBlocks } from './rootNodes'
import { sanitizeComposerImageSource } from './sanitize'

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
    let disposed = false
    // The same boundary the formatting toolbar refuses to act across.
    const isReadOnlyNode = (node: LexicalNode): boolean => {
      if ($isDecoratorNode(node)) return true
      const top = $topLevelComposerNode(node)
      if (!$isProtectedComposerNode(top)) return false
      return (
        top.getType() !== 'gmail-signature' ||
        editor.getElementByKey(top.getKey())?.getAttribute('contenteditable') !== null
      )
    }
    const unregisterCommand = registerCommands([
      createCommand('composer.pastePlainText', () => {
        // Lexical keeps the last range selection while the palette has focus.
        const selection = editor.getEditorState().read(() => {
          const current = $getSelection()
          if (!$isRangeSelection(current) || current.getNodes().some(isReadOnlyNode)) return null
          return current.clone()
        })
        if (!selection) return
        void navigator.clipboard
          .readText()
          .then((text) => {
            if (disposed || !text) return
            editor.update(
              () => {
                const anchor = $getNodeByKey(selection.anchor.key)
                const focus = $getNodeByKey(selection.focus.key)
                if (!anchor || !focus) return
                // Text may have changed while the clipboard was read.
                for (const [point, node] of [
                  [selection.anchor, anchor],
                  [selection.focus, focus]
                ] as const) {
                  const size = $isTextNode(node)
                    ? node.getTextContentSize()
                    : $isElementNode(node)
                      ? node.getChildrenSize()
                      : 0
                  point.set(point.key, Math.min(point.offset, size), point.type)
                }
                $setSelection(selection)
                $insertPlainClipboardText(selection, text)
              },
              { tag: HISTORY_PUSH_TAG }
            )
            editor.focus()
          })
          .catch(() => onError('Could not read clipboard text. Try pasting directly into the message.'))
      })
    ])
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
        const prepared = prepareHtmlForEditor(
          normalizeClipboardHtml(
            html,
            event.clipboardData?.types.includes('text/plain')
              ? event.clipboardData.getData('text/plain')
              : undefined
          )
        )
        if (prepared.issues.length > 0) onPreservedContent()
        const document = new DOMParser().parseFromString(prepared.html, 'text/html')
        preserveBlankLineBlocks(document)
        let missing = 0
        for (const image of document.querySelectorAll<HTMLImageElement>('img')) {
          const source = image.getAttribute('src') ?? ''
          if (!source.toLowerCase().startsWith('data:')) {
            if (sanitizeComposerImageSource(source)) continue
            // The clipboard named an image it does not carry. Notion writes
            // `attachment:` references only its own paste handler resolves;
            // the import sanitizer has already dropped that source, and a
            // bare <img> renders as a broken icon in the draft and the mail.
            const paragraph = image.parentElement
            image.remove()
            if (paragraph?.tagName === 'P' && !paragraph.childNodes.length) paragraph.remove()
            missing += 1
            continue
          }
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
        if (missing > 0) {
          onError(
            missing === 1
              ? 'One image was not on the clipboard. Drag the image file into the message.'
              : `${missing} images were not on the clipboard. Drag the image files into the message.`
          )
        }
        editor.update(() => $insertNodes($generateNodesFromDOM(editor, document)))
      })()
    }
    const unregisterRoot = editor.registerRootListener((root, previous) => {
      previous?.removeEventListener('paste', onPaste, true)
      root?.addEventListener('paste', onPaste, true)
    })
    return () => {
      disposed = true
      unregisterRoot()
      unregisterCommand()
    }
  }, [draftId, editor, onAttachment, onError, onPreservedContent])
  return null
}
