import { type SerializedTableCellNode, TableCellNode } from '@lexical/table'
import type { DOMExportOutput, LexicalEditor } from 'lexical'

/**
 * The border and padding the composer paints on every cell, as literal values
 * mail can carry. The composer's own rule uses a theme variable.
 */
export const MAIL_TABLE_CELL_BORDER = '1px solid rgb(201, 208, 214)'
export const MAIL_TABLE_CELL_PADDING = '6px 8px'

/**
 * Lexical's cell export stamps a 75px default width, a black border, a start
 * alignment, and a grey header background on every cell. The width is read
 * back on reopen, so a table with no authored widths collapsed to 75px columns
 * in the saved draft and in sent mail. Export the composer's presentation
 * instead, and a width only when the cell has one.
 */
export class ComposerTableCellNode extends TableCellNode {
  static getType(): string {
    return 'composer-tablecell'
  }

  static clone(node: ComposerTableCellNode): ComposerTableCellNode {
    return new ComposerTableCellNode(node.__headerState, node.__colSpan, node.__width, node.__key)
  }

  static importJSON(serialized: SerializedTableCellNode): ComposerTableCellNode {
    return new ComposerTableCellNode().updateFromJSON(serialized)
  }

  exportDOM(editor: LexicalEditor): DOMExportOutput {
    const output = super.exportDOM(editor)
    const element = output.element
    if (element instanceof HTMLElement) {
      if (this.getWidth() === undefined) element.style.removeProperty('width')
      if (this.getBackgroundColor() === null) element.style.removeProperty('background-color')
      element.style.removeProperty('text-align')
      element.style.border = MAIL_TABLE_CELL_BORDER
      element.style.padding = MAIL_TABLE_CELL_PADDING
    }
    return output
  }
}
