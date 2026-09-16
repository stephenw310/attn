# Known issues

For a new defect, record the symptom, steps to reproduce, affected symbol or test path, and verification date. Keep IDs stable and do not reuse them. Remove an entry when the defect is fixed.

### BUG-4: Clear formatting at a collapsed caret keeps a legacy font wrapper

Symptom: Clear formatting with a collapsed caret inside imported `<font>` markup, such as `<font color="red">Red</font>`, resets the text format and style for the next typed characters but leaves the caret inside the `LegacyFontNode`. Text typed at that caret still inherits and exports the font color, face, and size.

Steps to reproduce:

1. Open a draft that contains Gmail `<font color="red">Red</font>` markup.
2. Place the caret in the middle of the red text without selecting it.
3. Run Clear formatting from the formatting menu or the palette.
4. Type new characters. They remain red in the editor and in the saved HTML.

Workaround: select the text and run Clear formatting. A selection splits the wrapper and lifts the cleared run out of it.

Affected symbol: `$clearSelectionFormatting` in `src/renderer/src/composer/bodyEditing.ts`. The wrapper lift runs only for a non-collapsed selection. A collapsed caret would need a caret position between two inline elements, which Lexical does not represent for a plain caret.

Verified: 2026-09-16 on PR #131.
