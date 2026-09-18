# Test guide

Run tests from the repository root. Install dependencies with `npm install` first. No Google credentials are required.

## Choose a command

| Command | Purpose |
| --- | --- |
| `npm run verify` | Required check before completion, commit, or push |
| `npm run typecheck` | Check all three TypeScript projects |
| `npm run lint` | Check code style and formatting |
| `npm run test:unit` | Run main, preload, renderer, shared, and script unit tests |
| `npm run e2e` | Build and run the Electron end-to-end suite |
| `npm run e2e:only` | Run end-to-end tests without a build |
| `npm run e2e:only -- --grep <pattern>` | Run matching end-to-end tests |
| `npm run e2e -- --visible` | Run with visible Electron windows |
| `npm run e2e:perf` | Build and run interaction and memory checks |
| `npm run e2e:perf:scale` | Build and run the 40,000-thread read checks |
| `npm run e2e:perf:only` | Run interaction and memory checks without a build |
| `npm run e2e:perf:scale:only` | Run scale checks without a build |
| `npm run toolchain` | Repair the Electron and SQLite installation |

Use an `:only` command only when `out/` matches the current source.

## Unit tests

Use pure modules for decision logic. Use a mock `MailProvider` for network behavior.

Database tests can call `openDatabase(':memory:')` under Vitest. The SQLite dependency provides Node-API prebuilds, so these tests do not need Electron. See the tests in `src/main/outbox/` for examples.

Inject `SchedulerTime` or use Vitest fake timers for time-driven behavior. Do not wait for product retry or undo-send timers on the wall clock.

## Electron fixtures

`e2e/electron.ts` provides `app`, `page`, `userData`, and `mainLog`. Each test starts the real built Electron app with its main process, utility process, preload bridge, renderer, and SQLite store.

The fixture creates a temporary user data directory through `ATTN_TEST_USER_DATA`. The test app cannot read a developer's OAuth configuration. The app copies console output to `main.log` in the temporary directory.

Mail tests use deterministic seeded data:

```ts
test.use({ seed: 'fixtures/seed-inbox.json' })
```

`ATTN_TEST_SEED` works only with `ATTN_TEST_USER_DATA`. Signed-out tests exercise onboarding without a seed.

Windows stay hidden by default. `--visible` exposes them for diagnosis. Tests that explicitly request `--hidden` stay hidden. Linux runs use Xvfb when no display exists.

The fixture emulates a dark operating-system theme. Theme tests override that preference when they test System mode.

The fixture fails a test if any renderer launch logs a console error. Keep that assertion, including across relaunches.

## Seeds and persistence

Date fixture messages with `receivedDaysAgo`. Use `receivedAt` for the time of day. Avoid absolute `internalDate` values that move into older date groups over time.

Append new threads to `seed-inbox.json`. Do not reorder existing threads because triage tests depend on their positions. The `t-roadmap` thread has fixed threading headers and a Reply-To address that differs from From.

Put generated seeds in the ignored `e2e/.generated/` directory. CI uploads `e2e/.artifacts/`, so that directory must not contain generated mailbox data. Derive similar seeds instead of adding duplicate JSON fixtures.

Use `boot.relaunch()` to test persistence through a clean shutdown. Use `boot.relaunch({ kill: true })` for crash recovery. Relaunch keeps the same user data directory and does not reseed it.

Server-search fixtures map exact translated Gmail queries in `remoteSearches` to snapshots in `remoteThreads`. Unmapped queries return no results.

## Shared drivers

`e2e/nav.ts` owns navigation, command-palette actions, thread selection, and AI enablement. `e2e/seams.ts` owns `callSeam`, `emitSeam`, `fireSeam`, and named test controls. Add reusable helpers there.

`e2e/composer.ts` provides `ComposerPage`. Use `openNew()`, `openReply()`, and its editor and send methods.

Composer reads must wait for IPC completion:

- `expectRecipients()` checks the chips' normalized `data-email` values.
- `expectSaved()` waits for an exact saved revision newer than its previous observation on that mount.
- `expectPending()` waits for the header's user-action count.

Do not replace these checks with one-time snapshots or text fallbacks.

Hidden windows do not dispatch `selectionchange`. Lexical learns a clicked or arrowed caret from the next `beforeinput` event. To edit at a chosen position, click it and type a character first. Then delete through that character. Home, End, and Shift+Arrow selections do not update Lexical's internal selection in this environment.

## Test-only application controls

All `attn:test:*` controls live in `src/main/testIpc.ts`. `TestSeams` disables them outside the isolated test environment. Keep test branches out of production authentication and provider code.

| Control | Use |
| --- | --- |
| `reloadSeed` | Replay fixtures through `persistThread`; optionally replace the label catalog |
| `failNextAction`, `failNextActionAuth` | Test permanent action recovery or an account auth pause |
| `runLifetimeSweep` | Exercise the real sweep and durable cursor against a supplied provider |
| `runExistenceSweep` | Exercise ghost removal through the utility process |
| `listMailboxThreadIds` | Read production per-message mailbox membership |
| `runFtsBackfill` | Reset or pause real index backfill to test recovery |
| `searchIndexStats`, `queryPerfStats` | Measure production index and query work inside the utility process |
| `installFakeAiProvider`, `aiProviderRequests` | Control AI responses and inspect requests |
| `installFakeTriageProvider` | Arm the scripted TypeSafe service that answers split descriptions |
| `triageRequests` | Inspect the smart-splits request bodies that left the utility process |
| `runTriagePass` | Run the classifier to quiescence before a split assertion |
| `installSendProvider`, `setUndoSendDelay` | Control sends without Gmail or a wall-clock delay |
| `setSyncState`, `focusThread` | Set sync conditions or route notification focus |
| `crashUtility`, `utilityState` | Test utility-process restart and recovery |
| `delay*`, `failNextDraftSave`, `failOutbox` | Exercise delayed or failed persistence paths |
| `remoteDraft`, `setSearchWindow`, `setUpdateState` | Set remote-draft, search, and updater conditions |
| `holdNextResponse`, `observeInvokes`, `invokeHandler`, `failNextInvoke` | Control competing IPC operations |
| `expireReminders` | Back-date stored reminders before a relaunch |

The failed-action provider rejects only the selected thread once. It serves authoritative fixture snapshots until recovery or authentication retry completes. Seeded reconnect uses `TestSeams`; real OAuth recovery has unit coverage.

Assert requested formats and page tokens in sweep tests. This prevents a test control from hiding a full body fetch or a restart from page one. FTS backfill tests can reset the index and pause after committed batches to test durable recovery.

`holdNextResponse` parks a result after the real handler computes it. `observeInvokes` records arguments. `invokeHandler` calls a registered handler from main. `failNextInvoke` runs the real handler and then rejects, with optional substituted arguments.

These controls wrap `ipcMain.handle` registrations. Do not access Electron's private `_invokeHandlers` map.

## Control time and races

For renderer timers, use `page.clock.install()` and `resume()`. Use `fastForward` to advance an exact interval. After a held response is released, use `flushRendererIpc` to wait for IPC completion.

For reminders due at relaunch, create a future reminder and back-date it with `expireReminders`. Poll its pending count before relaunch. Do not add a sleep to `boot.relaunch()`.

Use `waitForTimeout` only when a test must prove that an event does not occur during a stated interval. Explain that interval in the test.

## Inspect failures and screenshots

Tests write screenshots to `e2e/.artifacts/` and traces to `e2e/.results/`. Failed tests attach the main-process log.

```sh
npx playwright show-trace <trace-path>
rg -n '\.artifacts' e2e --glob '*.spec.ts'
```

After a UI change, inspect every affected screenshot in each affected theme. Remove text-selection highlights from screenshot setup. Add screenshots to the relevant specs so the command above finds their writers.

## Performance checks

The regular performance profile has 10,000 threads and a second account with 1,000 threads. It checks list size, conversations, bulk actions, the composer, memory, and warm account switches. A separate generated profile checks search across 50,000 messages.

The scale profile imports 40,000 threads through production writes. It checks mailbox counts, All Mail pages, and common-term search. Small profiles cannot detect reads that grow with the entire store.

Frame timing requires normal display refresh. Use `--visible` when hidden-window throttling affects measurements. CI runs visible windows inside Xvfb. Keep hardware budgets separate from the hosted-Linux account-switch smoke ceiling.
