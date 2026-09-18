---
name: verify-attn
description: Drive the built Attn desktop app (Electron Gmail client) through the control-attn CLI against a throwaway profile and capture screenshots plus store reads as proof. Use to verify a mail feature or UI change on the real app, to reproduce a reported defect, or when a change claims to work and needs runtime evidence rather than a passing unit test.
disable-model-invocation: true
---

# Verify Attn

Attn's user surface is one Electron window. Every proof here boots the production build from `out/` with a fresh SQLite profile, drives it through `control-attn.mjs`, and writes evidence to a run directory that survives cleanup. Nothing here touches Gmail or a developer's real profile.

Read [features/README.md](features/README.md) before you drive. It lists the mapped features and the conventions each recipe follows.

The CLI is `node .cursor/skills/verify-attn/control-attn.mjs`. Every invocation is a fresh process. `launch` starts a detached daemon that holds the Playwright handle. Later commands talk to that daemon over a Unix socket.

## Launch

Build once, then launch one app instance.

```sh
npm run build
node .cursor/skills/verify-attn/control-attn.mjs launch --seed inbox
```

`launch` runs the doctor first and refuses on failure. It starts `out/main/index.js` through Playwright's Electron API with `ATTN_TEST_USER_DATA` set to a new `attn-verify-*` directory under the OS temp dir. `--seed inbox` sets `ATTN_TEST_SEED` to `e2e/fixtures/seed-inbox.json`. Any other name resolves to `e2e/fixtures/seed-<name>.json`. A value that contains `/` is used as a path.

The app is ready when `ping` succeeds. Confirm isolation with `doctor`. `main.log` in the profile directory contains `[db] open at ... attn-verify-... attn.db (schema vN)`. Windows stay hidden. Pass `--visible` to show them.

`launch` prints JSON with `runId`, `userData`, and `evidenceDir`. It also prints `ATTN_VERIFY_RUN=<runId>` on stderr. Export that value, or pass `--run <runId>` on later commands. If both are omitted, the CLI uses the newest run file.

Do not run `npm run dev` for verification. It uses the developer's real profile and real OAuth tokens.

`close` quits the app and deletes the profile. Evidence in `e2e/.artifacts/verify-attn/<runId>/` stays.

## Doctor

Run before the first launch and again after a command fails for a reason you do not understand.

```sh
node .cursor/skills/verify-attn/control-attn.mjs doctor
```

It is read-only. Pre-flight checks the Node version, that `out/main/index.js`, `out/preload/index.js`, and `out/renderer/index.html` exist and are newer than every file in `src/`, and that the Electron binary and the `better-sqlite3` prebuild for this platform exist. A stale build fails the check. Run `npm run build` and retry.

When a run is targeted, doctor also checks that the pid is alive, the socket answers `ping`, `info.userData` matches the run file, `main.log` shows the throwaway store, and the renderer error count is 0.

`launch` runs the pre-flight checks first.

## Drive

Issue commands against the live instance. Start from [features/inbox-reading.md](features/inbox-reading.md).

```sh
node .cursor/skills/verify-attn/control-attn.mjs press j
node .cursor/skills/verify-attn/control-attn.mjs eval "window.attn.mail.getUnreadCount()"
node .cursor/skills/verify-attn/control-attn.mjs screenshot 01-inbox-list
```

Select elements with `click <testid>`. Never select Tailwind classes. Drive the keyboard with `press <key>`. `ControlOrMeta` maps to Command on macOS and Control elsewhere.

Common moves:

- Open the command palette with `press ControlOrMeta+K`.
- Run a palette command with `press ControlOrMeta+K`, `fill command-palette-input <query>`, `press Enter`.
- Go to a mailbox with a G chord, for example `press g` then `press i` for Inbox.
- Send without Gmail or an undo delay with `seam setUndoSendDelay 0 --fire` then `seam installSendProvider`.
- Script AI replies with `seam installFakeAiProvider '{"chunks":["..."]}'`.
- Make Gmail reject the next action on a thread with `seam failNextAction t-roadmap`.

`seam <name>` reaches the test-only controls listed in `docs/TESTING.md`. The name maps to the `attn:test:<name>` channel. Extra arguments are parsed as JSON when they parse, otherwise passed as strings.

Stable handles used across the map:

| Handle | Meaning |
| --- | --- |
| `thread-row`, `data-selected`, `data-unread`, `data-thread-id` | A list row and its state |
| `thread-list`, `view-title`, `thread-date-group` | The list, its mailbox title, and date headers |
| `conversation-view`, `conversation-subject`, `message-card`, `conversation-back` | The reader |
| `command-palette`, `command-palette-input`, `command-palette-result`, `[data-command-id]` | The palette |
| `composer`, `composer-subject`, `composer-editor`, `composer-to`, `recipient-chip` | The composer |
| `search-input`, `search-open`, `search-coverage`, `search-all-gmail` | Search |
| `toast`, `toast-undo`, `pending-count`, `outbox-count` | Feedback and queued work |
| `snooze-picker`, `snooze-preset-tomorrow`, `selection-count` | Snooze and multi-select |

The daemon records leftover renderer console errors in `renderer-errors.log`. `info` reports the count. Keep that count at 0. It is part of the proof.

## Evidence

Each run writes to `e2e/.artifacts/verify-attn/<runId>/`. `launch` prints that path. `cleanup` does not delete it. The directory is git-ignored.

- `screenshot <name>` writes `<name>.png` in the evidence dir.
- `snapshot` prints ARIA text. Redirect it into the evidence dir when you need a file.
- `eval` prints a JSON result. Copy it into the evidence dir when you need a file.
- `log` prints the last lines of the profile `main.log`.
- `daemon.log`, `main-stdio.log`, and `renderer-errors.log` land in the evidence dir.

Proof standards for this app:

- Exercise the user path. Press the key or click the control. Do not call `window.attn.*` setters to reach a state and then screenshot it.
- Capture the action and the resulting state, not only the final screen. Number screenshots in order.
- Verify the side effect in the store alongside the screen. Production bridge reads are legitimate evidence, for example `eval "window.attn.mail.getUnreadCount()"` or `log`. Test seams set up conditions. They are not proof.
- Sends and AI calls cross a production boundary. `seam setUndoSendDelay 0 --fire` then `seam installSendProvider` installs the fake send provider with no undo delay. `seam installFakeAiProvider '{"chunks":[...]}'` installs the fake AI provider. Use them and no other mock. Without that send seam, a send waits in the undo window and never reaches a provider.
- Check `pending-count` after a mail action. Attn applies changes to SQLite first and queues the Gmail call. A queued row is the expected end state.

## Cleanup

`close` removes the profile it created. After a crashed or interrupted run:

```sh
node .cursor/skills/verify-attn/control-attn.mjs cleanup --dry-run
node .cursor/skills/verify-attn/control-attn.mjs cleanup
```

It removes run files whose pid is dead, their sockets, and their `attn-verify-*` profiles. It also removes orphan `attn-verify-*` dirs in the OS temp dir that no run file references and whose newest file is older than 60 minutes. `--all` also sends `close` to live runs, and SIGTERM the pid if the socket does not answer. It never touches `e2e/.artifacts`. `--dry-run` prints the plan and changes nothing.

Never `pkill Electron` or kill by process name. The developer's own Attn or another Electron app may be running.

## Helpers

| Command | Invocation | Purpose |
| --- | --- | --- |
| `launch` | `node .cursor/skills/verify-attn/control-attn.mjs launch --seed inbox` | Doctor, boot a throwaway instance |
| `doctor` | `node .cursor/skills/verify-attn/control-attn.mjs doctor` | Read-only pre-flight and live checks |
| `press` / `type` / `click` / `fill` / `wait` | `node .cursor/skills/verify-attn/control-attn.mjs press j` | Drive the window |
| `eval` / `seam` / `info` / `log` | `node .cursor/skills/verify-attn/control-attn.mjs eval "window.attn.mail.getUnreadCount()"` | Store reads and test seams |
| `snapshot` / `screenshot` | `node .cursor/skills/verify-attn/control-attn.mjs screenshot 01-inbox-list` | Evidence |
| `close` | `node .cursor/skills/verify-attn/control-attn.mjs close` | Quit and delete the profile |
| `cleanup` | `node .cursor/skills/verify-attn/control-attn.mjs cleanup` | Remove leftover profiles |
| `help` | `node .cursor/skills/verify-attn/control-attn.mjs help` | Usage for every command |

`npx biome check .cursor` formats the CLI. Keep it green.
