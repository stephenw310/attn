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

## Driving it with a verify-attn drive

Preconditions:

- Seed `fixtures/seed-inbox.json`. `page.getByTestId('thread-row')` has count 8 and `rows.nth(1)` contains `Northstar Books`.
- `pending-count` has count 0.

- **Archive.** Press E. Run `await page.keyboard.press('e')`. Rows drop to 7, `rows.first()` contains `Northstar Books` and has `data-selected="true"`, and `pending-count` contains `1 pending`.
- **Undo.** Press Z. Run `await page.keyboard.press('z')`. Rows return to 8 and `pending-count` contains `2 pending`.
- **Multi-select.** Press X then Shift+J seven times. Run `await page.keyboard.press('x')` and then `await page.keyboard.press('Shift+j')` in a loop of 7. `selection-count` reads `8 selected`.
- **Archive all.** Press E. Run `await page.keyboard.press('e')`. Rows drop to 0 and `thread-date-group` has count 0.
- **Snooze.** From a fresh baseline, press H and choose the tomorrow preset. Run `await page.keyboard.press('h')` and `await page.getByTestId('snooze-preset-tomorrow').click()`. `snooze-picker` was visible, rows drop to 7.
- **Snoozed mailbox.** Press G then H. Run `await goTo(page, 'h')` from `e2e/nav`. `view-title` reads `Snoozed`, one row contains `Maya Lin`, and its `chip-snooze-due` is visible.
- **Proof.** Snapshot after archive, after undo, and in Snoozed. Save the `pending-count` text and `window.attn.mail.getUnreadCount()` with `record()`.

## Gotchas

- Rows animate out with `data-exiting="true"` before they leave the DOM. Assert the final count with `expect(rows).toHaveCount(n)`, which retries, not a one-shot read.
- Undo queues a second action. `2 pending` after undo is correct, not a leak.
- The palette accepts an inline snooze argument such as `remind me tomorrow 9am`. That path is covered in [command-palette.md](./command-palette.md).
- `TEST_CHANNELS.failNextAction` makes Gmail reject the next action for one thread. It sets up a recovery scenario. The toast text `Couldn't archive ...` is the proof, not the seam call.
