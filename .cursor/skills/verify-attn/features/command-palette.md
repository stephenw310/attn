# Command palette

The command palette lists every command available in the current context. A user opens it with Mod+K, types to filter, and presses Enter to run the first result. Some commands accept an inline argument, and the palette remembers usage across restarts.

## Sub-features

- `palette-open` opens with Mod+K from the list, the reader, and the composer, and focuses its input.
- `palette-context` shows only commands valid in the current context.
- `palette-run` runs the highlighted result on Enter and closes.
- `palette-argument` parses an inline argument such as a snooze time.
- `palette-usage` ranks recently used commands first after a relaunch.

## How to get to it (user POV)

- Press `Mod+K` anywhere in the app. The footer shows the shortcut as `Command palette`.

## Driving it with a verify-attn drive

Preconditions:

- Seed `fixtures/seed-inbox.json`. `page.getByTestId('thread-row')` has count 8.

- **Open.** Press Mod+K. Run `await openPalette(page)` from `e2e/nav`. `command-palette` is visible, `command-palette-input` is focused, and the palette has `data-usage-loaded="true"`.
- **Context.** Check the list commands. Run `page.locator('[data-command-id="view.sent"]')`. It has count 1 alongside the other `view.*` chords.
- **Run.** Type and run a navigation command. Run `await runPaletteCommand(page, 'Go to Sent')`. `command-palette` has count 0 and `view-title` reads `Sent`.
- **Argument.** Open with a snooze phrase. Run `await openPalette(page, 'remind me tomorrow 9am')`. The `triage.snooze` result contains `Snooze until`. Press Enter with `await page.getByTestId('command-palette-input').press('Enter')`. Rows drop to 7 and `toast` reads `Snoozed`.
- **Usage.** Relaunch and reopen. Run `({ page } = await boot.relaunch())` then `await openPalette(page)`. `command-palette-result` first has `data-command-id="view.sent"`.
- **Proof.** Snapshot the open palette and the Sent view. Save `window.attn.settings.getCommandUsage('seed@attn.test')` with `record()`.

## Gotchas

- The Mod+K listener mounts with the app shell. `openPalette` retries the press until the input exists. Do not press once and assert.
- In the composer, `composer.new` and `search.open` are hidden. Their absence is the context proof, not a bug.
- Escape or clicking `command-palette-backdrop` closes the palette and returns focus to the previous control.
- Keys pressed while the palette is open stay in the palette. Pressing `e` does not archive a row behind it.
