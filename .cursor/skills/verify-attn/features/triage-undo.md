# Triage and undo

Triage lets a user archive, snooze, or act on one or many selected conversations from the keyboard. The row leaves the list at once, the selection advances, the change is queued for Gmail, and Z undoes the last action.

## Sub-features

- `triage-archive` removes the selected row with E and advances the selection to the next row.
- `triage-undo` restores the archived row with Z and queues the reversal.
- `triage-multi` selects a range with X and Shift+J and archives all selected rows with E.
- `triage-snooze` hides the row with H and a preset, and shows it in the Snoozed mailbox.
- `triage-toast` shows a toast for each action with the undo hint.

## How to get to it (user POV)

- Press `e` on a selected row in any list.
- Press `h` on a selected row to open the snooze picker.
- Press `x` to select the current row, then `Shift+j` to extend the range.
- Press `z` after any action to undo it.
- Run `Mark done`, `Snooze / remind me later`, or `Undo` from the command palette.

## Driving it with control-attn

Preconditions:

- Seed `inbox`. `eval "document.querySelectorAll('[data-testid=thread-row]').length"` returns 8 and the second row contains `Northstar Books`.
- `eval "document.querySelectorAll('[data-testid=pending-count]').length"` returns 0.

- **Archive.** Press E.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press e
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelectorAll('[data-testid=thread-row]').length"
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=thread-row]')?.textContent"
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=thread-row]')?.hasAttribute('data-selected')"
  node .cursor/skills/verify-attn/control-attn.mjs snapshot --testid pending-count
  ```

  Rows drop to 7, the first row contains `Northstar Books` and has `data-selected="true"`, and `pending-count` contains `1 pending`.

- **Undo.** Press Z.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press z
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelectorAll('[data-testid=thread-row]').length"
  node .cursor/skills/verify-attn/control-attn.mjs snapshot --testid pending-count
  ```

  Rows return to 8 and `pending-count` contains `2 pending`.

- **Multi-select.** Press X then Shift+J seven times.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press x
  node .cursor/skills/verify-attn/control-attn.mjs press Shift+j
  node .cursor/skills/verify-attn/control-attn.mjs press Shift+j
  node .cursor/skills/verify-attn/control-attn.mjs press Shift+j
  node .cursor/skills/verify-attn/control-attn.mjs press Shift+j
  node .cursor/skills/verify-attn/control-attn.mjs press Shift+j
  node .cursor/skills/verify-attn/control-attn.mjs press Shift+j
  node .cursor/skills/verify-attn/control-attn.mjs press Shift+j
  node .cursor/skills/verify-attn/control-attn.mjs snapshot --testid selection-count
  ```

  `selection-count` reads `8 selected`.

- **Archive all.** Press E.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press e
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelectorAll('[data-testid=thread-row]').length"
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelectorAll('[data-testid=thread-date-group]').length"
  ```

  Rows drop to 0 and `thread-date-group` has count 0.

- **Snooze.** From a fresh baseline, press H and choose the tomorrow preset.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press h
  node .cursor/skills/verify-attn/control-attn.mjs wait snooze-picker
  node .cursor/skills/verify-attn/control-attn.mjs click snooze-preset-tomorrow
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelectorAll('[data-testid=thread-row]').length"
  ```

  `snooze-picker` was visible, rows drop to 7.

- **Snoozed mailbox.** Press G then H.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press g
  node .cursor/skills/verify-attn/control-attn.mjs press h
  node .cursor/skills/verify-attn/control-attn.mjs wait view-title
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=view-title]')?.textContent"
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=thread-row]')?.textContent"
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=chip-snooze-due]') !== null"
  ```

  `view-title` reads `Snoozed`, one row contains `Maya Lin`, and its `chip-snooze-due` is visible.

- **Proof.** Snapshot after archive, after undo, and in Snoozed. Save the `pending-count` text and `window.attn.mail.getUnreadCount()`.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs screenshot 01-archived
  node .cursor/skills/verify-attn/control-attn.mjs screenshot 02-undone
  node .cursor/skills/verify-attn/control-attn.mjs screenshot 03-snoozed
  node .cursor/skills/verify-attn/control-attn.mjs eval "window.attn.mail.getUnreadCount()"
  ```

## Gotchas

- Rows animate out with `data-exiting="true"` before they leave the DOM. Re-run the row-count `eval` until it settles, not a one-shot read.
- Undo queues a second action. `2 pending` after undo is correct, not a leak.
- The palette accepts an inline snooze argument such as `remind me tomorrow 9am`. That path is covered in [command-palette.md](./command-palette.md).
- `seam failNextAction` makes Gmail reject the next action for one thread. It sets up a recovery scenario. The toast text `Couldn't archive ...` is the proof, not the seam call.
