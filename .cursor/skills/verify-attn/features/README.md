# Attn verification map

This directory is the maintained source for verifying the user-facing behavior of Attn. Read this index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Build the app with `npm run build`. `control-attn doctor` passes.
- Every run seeds `e2e/fixtures/seed-inbox.json` unless its preconditions name another fixture. That seed signs in `seed@attn.test` with 8 inbox rows, 4 of them unread. Row order from the top is `Q3 roadmap review` (Maya Lin), `Your receipt` (Northstar Books), `Design notes` (Theo Park), `Lunch next week`, `August budget`, `Flight options`, `Research summary`, and `This week in focus`.
- The app boots in the Inbox list with the first row selected.
- After `launch`, `doctor` reports that `info.userData` matches the throwaway profile and that `main.log` opened `attn.db` there.
- Never drive an instance that this run did not start.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Target with `click <testid>` and the handles named in the recipe. Do not select by class or DOM position.
- Press keys with `press <key>`. Treat every key and string as literal.
- Wait with `wait <testid>`. Do not sleep.
- A mutation leaves a queued action. Read `pending-count` as part of the result, not as an error.

## Proof and skip reporting

- Capture the user action and the resulting state with numbered `screenshot` calls.
- Pair every UI claim with a store read through the production bridge (`eval "window.attn.mail.*"` / `eval "window.attn.settings.*"`) or a `log` match. Save those JSON values into the evidence dir when you need a file.
- Record the feature ID and entry point used with every artifact.
- Report an unreachable path with the attempted step and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with control-attn` starts with `Preconditions:` and uses labeled bullets that pair each user action with CLI lines and the observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Inbox list and reader](./inbox-reading.md) covers J/K selection, opening a conversation, mark-as-read, and returning to the list.
- [Triage and undo](./triage-undo.md) covers archive, auto-advance, multi-select, snooze, and undo of the last action.
- [Command palette](./command-palette.md) covers opening the palette, running a navigation command, and running a command with an inline argument.
- [Compose and send](./compose-send.md) covers a new message, recipients, the undo-send window, and a send through the outbox.
- [Search](./search.md) covers local search as typed, opening a result, restoring the mailbox, and the search-all-Gmail prompt.
- [Labels and move](./labels-and-move.md) covers the label picker, apply, and undo.
- [Follow-up reminders](./follow-up-reminders.md) covers setting a follow-up on a reply and finding it in reminders.
- [Split inbox](./splits.md) covers the split strip, tab switching, and split rules.
- [Settings and themes](./settings-and-themes.md) covers Mod+, settings and Light/Dark/System themes.
- [Multiple accounts](./multiple-accounts.md) covers switching accounts with Mod+N.
- [AI drafting](./ai-drafting.md) covers Mod+J reply drafting under the fake provider.
- [Onboarding](./onboarding.md) covers the signed-out login screen without an OAuth client.
