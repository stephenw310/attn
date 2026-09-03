import { $generateNodesFromDOM } from '@lexical/html'
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext'
import { $createParagraphNode, $getRoot, $nodesOfType, HISTORY_MERGE_TAG } from 'lexical'
import { useLayoutEffect } from 'react'
import { normalizedContentId, TRANSPARENT_IMAGE } from '../mailInlineImages'
import { ImageNode } from './nodes/ImageNode'
import { preserveBlankLineBlocks, rootLevelNodes } from './rootNodes'

/** Load a draft's stored body into the editor once, then resolve its CID images. */
export function InitialHtmlPlugin({ draftId, html }: { draftId: string; html: string }): null {
  const [editor] = useLexicalComposerContext()
  useLayoutEffect(() => {
    if (!html) return
    let cancelled = false
    const document = new DOMParser().parseFromString(html, 'text/html')
    preserveBlankLineBlocks(document)
    const contentIds = [...document.querySelectorAll<HTMLImageElement>('img[src]')].flatMap((image) => {
      const source = image.getAttribute('src') ?? ''
      if (!source.toLowerCase().startsWith('cid:') || !window.attn) return []
      // The node keeps the sender's own `cid` text, so a stored draft still
      // round-trips byte-for-byte; only the lookup key is normalized.
      const contentId = source.slice(4)
      image.setAttribute('src', TRANSPARENT_IMAGE)
      image.setAttribute('data-attn-cid', contentId)
      return [normalizedContentId(contentId)]
    })
    editor.update(
      () => {
        const nodes = rootLevelNodes($generateNodesFromDOM(editor, document))
        const root = $getRoot()
        root.clear()
        root.append(...(nodes.length > 0 ? nodes : [$createParagraphNode()]))
      },
      { tag: 'attn-initial-html' }
    )
    void Promise.all(
      contentIds.map(async (contentId) => {
        const result = await window.attn?.draft.getInlineImage(draftId, contentId)
        return [contentId, result && 'dataUrl' in result ? result.dataUrl : TRANSPARENT_IMAGE] as const
      })
    ).then((resolved) => {
      if (cancelled) return
      const sources = new Map(resolved)
      editor.update(
        () => {
          for (const image of $nodesOfType(ImageNode)) {
            const source = sources.get(normalizedContentId(image.getContentId()))
            if (source) image.setSrc(source)
          }
        },
        // Swapping the placeholder for the resolved image is not an edit the
        // user made, so it merges into the current history entry rather than
        // becoming the state one Mod+Z restores.
        { tag: ['attn-inline-image-load', HISTORY_MERGE_TAG] }
      )
    })
    return () => {
      cancelled = true
    }
  }, [draftId, editor, html])
  return null
}
