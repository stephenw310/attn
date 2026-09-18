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

## Driving it with control-attn

Preconditions:

- Seed `inbox`. `eval "document.querySelectorAll('[data-testid=thread-row]').length"` returns 8.

- **Open.** Press Mod+K.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press ControlOrMeta+K
  node .cursor/skills/verify-attn/control-attn.mjs wait command-palette
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.activeElement?.getAttribute('data-testid')"
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=command-palette]')?.getAttribute('data-usage-loaded')"
  node .cursor/skills/verify-attn/control-attn.mjs screenshot 01-palette
  ```

  `command-palette` is visible, `command-palette-input` is focused, and the palette has `data-usage-loaded="true"`.

- **Context.** Check the list commands.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelectorAll('[data-command-id=\"view.sent\"]').length"
  node .cursor/skills/verify-attn/control-attn.mjs eval "[...document.querySelectorAll('[data-command-id]')].map(el => el.getAttribute('data-command-id')).filter(id => id && id.startsWith('view.'))"
  ```

  The count is 1. The `view.*` ids are `view.inbox`, `view.allMail`, `view.sent`, `view.starred`, `view.snoozed`, `view.drafts`, `view.spam`, `view.trash`, and `view.outbox`.

- **Argument.** Type a snooze phrase while the palette is still open and the Inbox still has 8 rows.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs fill command-palette-input "remind me tomorrow 9am"
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-command-id=\"triage.snooze\"]')?.textContent"
  node .cursor/skills/verify-attn/control-attn.mjs press Enter
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelectorAll('[data-testid=thread-row]').length"
  node .cursor/skills/verify-attn/control-attn.mjs snapshot --testid toast
  ```

  The `triage.snooze` result contains `Snooze until`. After Enter, rows drop to 7 and `toast` reads `Snoozed`.

- **Run.** Reopen the palette and run a navigation command.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press ControlOrMeta+K
  node .cursor/skills/verify-attn/control-attn.mjs wait command-palette-input
  node .cursor/skills/verify-attn/control-attn.mjs fill command-palette-input "Go to Sent"
  node .cursor/skills/verify-attn/control-attn.mjs press Enter
  node .cursor/skills/verify-attn/control-attn.mjs wait view-title
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=view-title]')?.textContent"
  node .cursor/skills/verify-attn/control-attn.mjs screenshot 02-sent
  ```

  `command-palette` is gone and `view-title` reads `Sent`.

- **Usage.** Open the palette again in this session after running Go to Sent. `close` deletes the profile, so ranking after a second `launch` is a fresh store.

  ```sh
  node .cursor/skills/verify-attn/control-attn.mjs press ControlOrMeta+K
  node .cursor/skills/verify-attn/control-attn.mjs wait command-palette
  node .cursor/skills/verify-attn/control-attn.mjs eval "document.querySelector('[data-testid=command-palette-result]')?.getAttribute('data-command-id')"
  node .cursor/skills/verify-attn/control-attn.mjs eval "window.attn.settings.getCommandUsage('seed@attn.test')"
  ```

  The first result is `view.sent`. `getCommandUsage` returns `view.sent` and `triage.snooze` each with `count` 1.

  Not yet driven: ranking after a second launch. `close` deletes the profile.

## Gotchas

- The Mod+K listener mounts with the app shell. A press that lands too early is dropped. If `wait command-palette` fails, press `ControlOrMeta+K` again.
- In the composer, `composer.new` and `search.open` are hidden. Their absence is the context proof, not a bug.
- Escape or `click command-palette-backdrop` closes the palette and returns focus to the previous control.
- Keys pressed while the palette is open stay in the palette. Pressing `e` does not archive a row behind it.
- A snooze argument run from Sent does not drop Inbox rows to 7. Run that step from Inbox before `Go to Sent`.
