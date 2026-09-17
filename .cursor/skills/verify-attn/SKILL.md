---
name: verify-attn
description: Drive the built Attn desktop app (Electron Gmail client) with Playwright against a throwaway profile and capture screenshots plus store reads as proof. Use to verify a mail feature or UI change on the real app, to reproduce a reported defect, or when a change claims to work and needs runtime evidence rather than a passing unit test.
disable-model-invocation: true
---

# Verify Attn

Attn's user surface is one Electron window. Every proof here boots the production build from `out/` with a fresh SQLite profile, drives it through Playwright's Electron API, and writes evidence to a run directory that survives cleanup. Nothing here touches Gmail or a developer's real profile.

Read [features/README.md](features/README.md) before you drive. It lists the mapped features and the conventions each recipe follows.

## Launch

Build once, then each drive boots its own app instance.

```sh
npm run build
```

A drive launches `out/main/index.js` through the `e2e/electron.ts` fixture with `ATTN_TEST_USER_DATA` set to a new `attn-e2e-*` directory under the OS temp dir and `ATTN_TEST_SEED` pointing at a fixture in `e2e/fixtures/`. The app is ready when `firstWindow()` resolves and `main.log` in that directory contains `[db] open at ... attn.db (schema vN)`. Windows stay hidden. Pass `--visible` to `drive.mjs` to show them.

Teardown is automatic. The fixture calls `app.close()` and deletes the profile directory when the drive ends, pass or fail.

Two instances can run side by side because each owns its profile. Do not run `npm run dev` for verification. It uses the developer's real profile and real OAuth tokens.

## Doctor

Run before the first drive and again after any drive fails for a reason you do not understand.

```sh
node .cursor/skills/verify-attn/scripts/doctor.mjs
```

It is read-only. It checks the Node version, that `out/main/index.js`, `out/preload/index.js`, and `out/renderer/index.html` exist and are newer than every file in `src/`, that the Electron binary and the `better-sqlite3` prebuild for this platform exist, and it counts leftover `attn-e2e-*` profiles. A stale build fails the check. Run `npm run build` and retry.

Inside a drive, `assertIsolated(app, userData, mainLog)` from `drives/harness.ts` is the live-instance doctor. It confirms `app.getPath('userData')` is the throwaway directory and that the store opened there.

`drive.mjs` runs the doctor first. Pass `--skip-doctor` only when you ran it moments ago.

## Drive

Write a drive as a Playwright spec in `.cursor/skills/verify-attn/drives/`. Name a throwaway drive `scratch-<name>.spec.ts`. Git ignores that prefix. Start from [drives/inbox-reading.spec.ts](drives/inbox-reading.spec.ts).

```sh
node .cursor/skills/verify-attn/scripts/drive.mjs scratch-<name>
node .cursor/skills/verify-attn/scripts/drive.mjs --visible --grep "marks it read"
```

Arguments after the script name pass through to Playwright. `--visible` shows the window.

Import the fixture and drivers the e2e suite already owns. Paths are relative to `drives/`.

- `../../../../e2e/electron` gives `test`, `expect`, and the `app`, `page`, `userData`, `mainLog`, and `boot` fixtures. `test.use({ seed: 'fixtures/seed-inbox.json' })` seeds the store.
- `../../../../e2e/nav` gives `goTo(page, key)` for G chords, `threadRow(page, subject)`, `selectedIndex(page)`, `openPalette(page, query)`, `runPaletteCommand(page, query)`, and `enableAi(page)`.
- `../../../../e2e/composer` gives `ComposerPage` with `openNew()`, `openReply()`, `addRecipient()`, `typeBody()`, `triggerSend()`, `expectPending(n)`, and `expectSaved()`.
- `../../../../e2e/seams` gives `armSending(app)`, `installFakeAi(app, script)`, `setSyncState(app, state)`, `expireReminders(app, n)`, and `flushRendererIpc(page)`.

Select elements with `page.getByTestId(...)`. Never select Tailwind classes. Drive the keyboard with `page.keyboard.press(...)`. `ControlOrMeta` maps to Command on macOS and Control elsewhere. Stable handles used across the map:

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

The fixture fails a drive when the renderer logs a console error. Keep that behavior. It is part of the proof.

## Evidence

Each run writes to `e2e/.artifacts/verify-attn/<run-id>/`. `drive.mjs` prints the run id and lists every file at the end. The directory is git-ignored and outlives cleanup.

Use the helpers in `drives/harness.ts`.

- `snap(page, testInfo, '01-name')` writes `<drive-slug>/01-name.png`.
- `record(testInfo, 'name.json', value)` writes text or JSON beside the screenshots.
- Playwright writes a trace to `<run-id>/results/` when a drive fails. Open it with `npx playwright show-trace <path>`.

Proof standards for this app:

- Exercise the user path. Press the key or click the control. Do not call `window.attn.*` setters to reach a state and then screenshot it.
- Capture the action and the resulting state, not only the final screen. Number screenshots in order.
- Verify the side effect in the store alongside the screen. Production bridge reads are legitimate evidence, for example `page.evaluate(() => window.attn.mail.getUnreadCount())` or `mainLog()`. Test seams in `e2e/seams.ts` set up conditions. They are not proof.
- Sends and AI calls cross a production boundary. `armSending(app)` installs the fake send provider with no undo delay. `installFakeAi(app, script)` installs the fake AI provider. Use them and no other mock. Without `armSending`, a send waits in the undo window and never reaches a provider.
- Check `pending-count` or `expectPending(n)` after a mail action. Attn applies changes to SQLite first and queues the Gmail call. A queued row is the expected end state.

## Cleanup

The fixture removes the profile it created when the drive exits. After a crashed or interrupted run:

```sh
node .cursor/skills/verify-attn/scripts/cleanup.mjs
node .cursor/skills/verify-attn/scripts/cleanup.mjs --older-than 0
```

It removes `attn-e2e-*` profiles in the OS temp dir whose newest file is older than the threshold (default 60 minutes) and nothing else. Use `--older-than 0` only when no Attn test or verification run is active on this machine.

Stop a hung run with Ctrl-C. Playwright closes the Electron process it launched. Never `pkill Electron` or kill by process name. The developer's own Attn or another Electron app may be running.

Delete `drives/scratch-*.spec.ts` when the proof is done, or rename the file and add it to the feature map if it proves a mapped feature better than the current recipe.

## Helpers

| Script | Invocation | Purpose |
| --- | --- | --- |
| `scripts/doctor.mjs` | `node .cursor/skills/verify-attn/scripts/doctor.mjs` | Read-only pre-flight |
| `scripts/drive.mjs` | `node .cursor/skills/verify-attn/scripts/drive.mjs [--visible] [--skip-doctor] [playwright args]` | Doctor, run drives, list evidence |
| `scripts/cleanup.mjs` | `node .cursor/skills/verify-attn/scripts/cleanup.mjs [--older-than <minutes>]` | Remove leftover profiles |
| `drives/harness.ts` | `import { assertIsolated, record, snap } from './harness'` | Live doctor and evidence writers |
| `playwright.config.ts` | Used by `drive.mjs`, which sets `ATTN_VERIFY_RUN` | Runs `drives/` only, one worker, 60 s timeout |
| `scripts/fs.mjs` | Imported by `doctor.mjs` and `cleanup.mjs` | Newest file mtime under a directory |

`npm run typecheck` covers `drives/` and this config. `npm run lint` formats them. Keep both green.
