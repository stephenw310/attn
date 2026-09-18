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

### BUG-16: The described-split threshold is an untuned starting value

Symptom: A described split can over-claim or under-claim conversations. The stored yes-probability decides membership at a fixed cutoff that no evaluation has set. A description that reads well can still collect unrelated mail, or leave the mail it describes in Other.

Steps to reproduce:

1. Enable smart splits and save a TypeSafe key.
2. Create a split whose only condition is a description, such as "Anything from my landlord".
3. Wait for the classifier pass to finish.
4. Compare the split against the conversations you expect. Borderline conversations fall on either side.

Workaround: rewrite the description with a concrete example, or add a hard condition to the rule.

Affected symbol: `SPLIT_TRIAGE_THRESHOLD` in `src/main/sync/tuning.ts`. The shipped value is 0.7. A dogfood evaluation over real mail must set the number.

Verified: 2026-09-17 on the smart-splits branch.

### BUG-17: An older build hides a rule that holds a description

Symptom: A user who installs a build older than smart splits loses every split rule that holds a description condition. The rule disappears from the Inbox strip and from the split-rule manager. Its conversations fall through to the next matching split, or to Other.

Steps to reproduce:

1. Create a split whose conditions include a description.
2. Install a build from before smart splits shipped.
3. Open the Inbox. The described split is absent.
4. Install the current build again. The split returns with its conditions intact.

Workaround: upgrade to a build that parses a description condition.

Affected symbol: `parseSplitMatchJson` in `src/main/splits.ts`. The older normalizer rejects the unknown condition type and returns null, so the caller skips the row. The stored row is not deleted and not rewritten, which is why the upgrade restores it.

Verified: 2026-09-17 on the smart-splits branch.
