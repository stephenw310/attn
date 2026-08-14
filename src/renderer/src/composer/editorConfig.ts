import { LinkNode } from '@lexical/link'
import { ListItemNode, ListNode } from '@lexical/list'
import type { InitialConfigType } from '@lexical/react/LexicalComposer'
import { QuoteNode } from '@lexical/rich-text'

export const editorConfig: InitialConfigType = {
  namespace: 'attn-composer',
  nodes: [LinkNode, ListNode, ListItemNode, QuoteNode],
  theme: {
    link: 'app-composer-link',
    list: {
      listitem: 'app-composer-list-item',
      nested: { listitem: 'app-composer-list-item-nested' },
      ol: 'app-composer-list app-composer-list-ordered',
      ul: 'app-composer-list app-composer-list-unordered'
    },
    paragraph: 'app-composer-paragraph',
    quote: 'app-composer-quote',
    text: {
      bold: 'app-composer-bold',
      italic: 'app-composer-italic',
      underline: 'app-composer-underline'
    }
  },
  onError(error) {
    throw error
  }
}
