# Labels and move

A user applies or removes a label from a conversation with L, searches the label picker, and undoes the change with Z. The sidebar label count updates with the change.

## Sub-features

- `label-open` opens the label picker with L and focuses its search field.
- `label-search` filters options as typed.
- `label-apply` toggles a label onto the selected conversation and queues the change.
- `label-undo` removes the label with Z and queues the reversal.

## How to get to it (user POV)

- Press `l` on a selected row or inside the reader.
- Run `Label` from the command palette.

## Driving it with control-attn

Preconditions:

- Seed `inbox`. The first row is Maya Lin with no `label-chip`. The sidebar `projects` count is `1`.

- **Open.** Press L.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press l
  node .cursor/skills/verify-attn/control-attn.mjs wait label-picker
  node .cursor/skills/verify-attn/control-attn.mjs wait label-search
  ```

  `label-picker` is visible and `label-search` is focused.

- **Search.** Type a prefix.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs fill label-search proj
  node .cursor/skills/verify-attn/control-attn.mjs eval "[...document.querySelectorAll('[data-testid=label-option]')].map(el => ({text: el.textContent, state: el.getAttribute('data-state')}))"
  ```

  One option remains. Its text contains `projects` and its `data-state` is `off`.

- **Apply.** Press Enter.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press Enter
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=thread-row]')?.querySelector('[data-testid=label-chip]')?.textContent"
  node .cursor/skills/verify-attn/control-attn.mjs snapshot --testid pending-count
  ```

  The first row shows a `projects` chip, `pending-count` reads `1 pending`, and the sidebar `projects` count becomes `2`.

- **Undo.** Press Escape to close the picker, then Z.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press Escape
  node .cursor/skills/verify-attn/control-attn.mjs press z
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelectorAll('[data-testid=thread-row]')[0]?.querySelectorAll('[data-testid=label-chip]').length"
  node .cursor/skills/verify-attn/control-attn.mjs snapshot --testid pending-count
  ```

  The chip is gone and `pending-count` reads `2 pending`.

- **Proof.**

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs screenshot 01-labeled
  ```

## Gotchas

- The picker option text can include a checkmark character. Assert `data-state` and the chip text, not the option's full text.
- Opening the picker from the reader also marks the conversation read and can leave `1 pending` before any label change.
- Move-to-mailbox paths are not covered in this recipe. See `e2e/move.spec.ts` for the Move command.
