import { LinkNode } from '@lexical/link'
import { ListItemNode, ListNode } from '@lexical/list'
import type { InitialConfigType } from '@lexical/react/LexicalComposer'
import { QuoteNode } from '@lexical/rich-text'
import { TableCellNode, TableNode, TableRowNode } from '@lexical/table'
import { TextNode } from 'lexical'
import { GmailSignatureNode } from './nodes/GmailSignatureNode'
import { GmailSignaturePrefixNode } from './nodes/GmailSignaturePrefixNode'
import { ImageNode } from './nodes/ImageNode'
import { LegacyFontNode } from './nodes/LegacyFontNode'
import { OpaqueHtmlNode } from './nodes/OpaqueHtmlNode'
import { StyledTextNode } from './nodes/StyledTextNode'

export const editorConfig: InitialConfigType = {
  namespace: 'attn-composer',
  nodes: [
    LinkNode,
    ListNode,
    ListItemNode,
    QuoteNode,
    TableNode,
    TableRowNode,
    TableCellNode,
    ImageNode,
    GmailSignatureNode,
    GmailSignaturePrefixNode,
    LegacyFontNode,
    OpaqueHtmlNode,
    StyledTextNode,
    {
      replace: TextNode,
      with: (node: TextNode) => new StyledTextNode(node.getTextContent()),
      withKlass: StyledTextNode
    }
  ],
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
      strikethrough: 'app-composer-strikethrough',
      underline: 'app-composer-underline'
    },
    table: 'app-composer-table',
    tableCell: 'app-composer-table-cell',
    tableCellHeader: 'app-composer-table-cell-header',
    tableRow: 'app-composer-table-row'
  },
  onError(error) {
    throw error
  }
}
