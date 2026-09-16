import { type SerializedTableNode, TableNode } from '@lexical/table'
import type { DOMExportOutput, LexicalEditor } from 'lexical'

/** The composer collapses cell borders; mail needs the rule inline. */
export class ComposerTableNode extends TableNode {
  static getType(): string {
    return 'composer-table'
  }

  static clone(node: ComposerTableNode): ComposerTableNode {
    return new ComposerTableNode(node.__key)
  }

  static importJSON(serialized: SerializedTableNode): ComposerTableNode {
    return new ComposerTableNode().updateFromJSON(serialized)
  }

  exportDOM(editor: LexicalEditor): DOMExportOutput {
    const output = super.exportDOM(editor)
    if (output.element instanceof HTMLElement) output.element.style.borderCollapse = 'collapse'
    return output
  }
}
