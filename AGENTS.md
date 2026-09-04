# AGENTS.md

Working agreement for coding agents on **Attn** — a keyboard-first, local-first desktop email client (Electron + React + TypeScript + SQLite) in the Dispatch visual direction (full-width list ⇄ full-window conversation/composer). **This file records how to work in this repo, never project status: milestone state and task progress live in [docs/SPEC.md](docs/SPEC.md) §8 and the plan docs (`docs/M*-PLAN.md`), which are updated as part of shipping — do not record them here, where they rot.**

This is the only file you need to start work, and the one place these rules live — tool-specific entry points (`.claude/CLAUDE.md`) just import it, so edit this file rather than copying rules elsewhere. [docs/SPEC.md](docs/SPEC.md) is the source of truth for product behavior — consult it for any feature question. [README.md](README.md) covers human onboarding (prerequisites, Google OAuth client setup); you don't need Google credentials to build or test.

## Verification contract

**A change is not done until `npm run verify` is green.** Run it before claiming completion, committing, or pushing.

```
npm run verify     # typecheck (3 project tsconfigs) → biome ci → unit → build → e2e
```

The e2e suite (Playwright) drives the **real built Electron app** — main process, SQLite, preload bridge, IPC, and keyboard loop — headless. On display-less Linux it wraps itself in Xvfb automatically; `--no-sandbox` is added automatically when running as root or in CI.

| Command | Use |
|---|---|
| `npm run verify` | The full gate — the definition of done |
| `npm run test:unit` | Unit tests across main + renderer. Decisions live in pure planner modules, but DB-touching code can be unit-tested too: better-sqlite3 ships Node-API prebuilds, so `openDatabase(':memory:')` works under vitest (see `outbox/{spool,queue,inlineImages}.test.ts`) — no Electron needed |
| `npm run e2e` | Build + e2e only |
| `npm run e2e:only` | E2e without rebuilding — **only** when `out/` already matches `src/` |
| `npm run e2e:only -- --grep <pattern>` | One test while iterating |
| `npm run e2e:perf` | Build + generated two-account Electron profile — 10,000 threads plus a 1,000-thread second account (windowing, main private + utility heap/external/SQLite-cache memory, list/conversation/bulk/composer budgets, warm account-switch p95) |
| `npm run e2e:perf:scale` | Build + generated 40,000-thread profile for reads that must not scale with the store (mailbox counts, All Mail paging, common-term search). Opt-in: the profile imports through the production write path before measuring reads. The 10,000-thread job cannot catch this class — the account scan it was added for measured under a millisecond there |
| `npm run e2e:perf:only` / `e2e:perf:scale:only` | The same two perf jobs without rebuilding — **only** when `out/` already matches `src/` |
| `npm run typecheck` / `npm run lint` | Fast static passes |
| `npm run toolchain` | Repair Electron binary / native-module ABI (also runs as postinstall) |
| `npm run package:dir` | Build and verify an unpacked app for the current platform |
| `npm run package:mac` / `package:mac:all` | Build and verify macOS artifacts for one/both architectures |
| `npm run package:win` | Build and verify the Windows installer for the current architecture |
| `npm run package:verify` | Assert packaged runtime assets and native module architecture |
| `npm run release:mac` / `release:win` | Release-mode packaging: signed, notarized (macOS), feed declared, then `package:verify --release`. Needs `ATTN_DISTRIBUTION_MODE=release`, `ATTN_RELEASE_FEED`, and the signing credentials in [docs/RELEASE.md](docs/RELEASE.md); the `Release` workflow runs both on a `v*` tag |
| `npm run release:stamp-feed -- <dir> --assets-base <url>` | Rewrite `latest*.yml` for the per-schema feed (absolute asset URLs plus `requiredSchemaVersion`) before upload; the updater refuses an unstamped feed entry |

**Visual self-check:** the e2e suite rewrites `e2e/.artifacts/login.png`, `inbox.png`, `inbox-light.png`, `all-mail.png`, `sidebar-collapsed.png`, `trash-marker.png`, `reading.png`, `reading-light.png`, `remote-images-blocked.png`, `reader-controls.png`, `message-selected-expanded.png`, `message-cursor.png`, `message-inline-reply.png`, `message-inline-reply-light.png`, `simple-mail.png`, `mail-layout.png`, `mail-layout-light.png`, `neutral-backgrounds-light.png`, `mixed-reply-light.png`, `mixed-reply-dark.png`, `mixed-quote-light.png`, `mixed-quote-dark.png`, `apple-mail-backgrounds-light.png`, `apple-mail-backgrounds-dark.png`, `apple-mail-quote-light.png`, `apple-mail-quote-dark.png`, `colored-reply.png`, `label-picker.png`, `move-picker.png`, `auth-paused.png`, `account-menu.png`, `account-removal-error.png`, `composer.png`, `composer-formatting.png`, `inline-reply.png`, `draft-chip.png`, `attachments.png`, `newsletter-quote.png`, `gmail-draft.png`, `composer-signature-collapsed.png`, `composer-signature-quote-collapsed.png`, `composer-reply-empty-lines.png`, `composer-signature-font.png`, `composer-signature-prefix-collapsed.png`, `composer-signature-prefix-expanded.png`, `composer-attn-signature.png`, `composer-attn-signature-light.png`, `ai-draft.png`, `ai-autocomplete.png`, `ai-autocomplete-light.png`, `label-view.png`, `search.png`, `search-partial.png`, `search-capped.png`, `server-search.png`, `server-search-cached.png`, `palette.png`, `split-inbox.png`, `split-rules.png`, `split-rules-drag.png`, `chord-guide.png`, `settings.png`, `settings-scopes.png`, `settings-ai.png`, `settings-sync.png`, `settings-about.png`, `cheat-sheet.png`, `snippet-manager.png`, `inbox-zero.png`, and `inbox-zero-light.png` (grep `e2e/*.spec.ts` for `.artifacts` when adding one, and list it here). After UI changes, inspect every affected artifact and confirm the rendering matches intent; test setup must not leave text-selection highlights in screenshots. Failure debugging: traces land in `e2e/.results/` (`npx playwright show-trace …`), and the main-process log is attached to failed tests.

## How the e2e harness works

- Signed-out tests exercise the onboarding screen. Mail-feature suites use a deterministic seeded real SQLite store, so OAuth and Gmail are never involved and the suite stays runnable with zero credentials.
- Electron windows stay hidden by default so local e2e runs do not flash or steal focus. Pass `--visible` through either e2e script (for example, `npm run e2e -- --visible`) when debugging with an OS-visible window; specs that explicitly launch with `--hidden` remain hidden.
- The e2e fixture emulates a dark OS preference so the original Dispatch screenshots and color assertions stay deterministic on light and dark developer machines. Theme specs override the emulated preference when they exercise F14's System behavior.
- Specs can opt into a seeded real SQLite store with `test.use({ seed: 'fixtures/seed-inbox.json' })`; the underlying `ATTN_TEST_SEED` seam is honored only alongside `ATTN_TEST_USER_DATA`. Date seed messages with `receivedDaysAgo` (day-anchored, `receivedAt` for the wall-clock time) rather than an absolute `internalDate` — absolute stamps drift into "Older" as the repo ages, which breaks date-group assertions and makes `inbox.png` read as stale mail.
- The `boot.relaunch()` helper restarts Electron against the same userData directory and returns the new app and page, so durability tests exercise persisted state without reseeding. `relaunch({ kill: true })` SIGKILLs the app instead of quitting it, which is what a crash-recovery test must use; keep the graceful form where the assertion is about clean shutdown (the draft-checkpoint quiescence).
- Each test boots its own app instance against a throwaway userData dir via the `ATTN_TEST_USER_DATA` seam (`src/main/index.ts`) — fresh DB, no tokens, and a developer's real `oauth.config.json` can't leak in. Under that seam the app also tees console output to `main.log` in the same dir, which is what makes boot-time lines assertable.
- Fixtures live in `e2e/electron.ts` (`app`, `page`, `userData`, `mainLog`). The boot fixture fails any test that produced renderer console errors — collected across every launch, `relaunch()` included — keep it that way.
- Seed messages may carry optional `messageId` and `references` fields for RFC threading tests. The visible `t-roadmap` fixture pins both headers plus a latest-message `Reply-To` that differs from `From`; append new fixture threads rather than reordering the existing list because triage specs depend on its indices. The test-only `attn:test:reloadSeed` main-process event replays the fixture through `persistThread` so idempotent derived data can be regression-tested; it may also receive an authoritative label array, replacing the seeded catalog and broadcasting `mail:changed` when that catalog differs so poller-driven picker refreshes can be exercised without Gmail.
- Server-search fixtures may place snapshots in `remoteThreads` and map exact translated Gmail queries to their ids in `remoteSearches`. Unmapped queries return no remote ids, so an e2e cannot pass by receiving a server result that does not match its query.
- The test-only `attn:test:failNextAction` and `attn:test:failNextActionAuth` events install a seeded provider that rejects only the named thread once, serves authoritative snapshots for every fixture thread while installed, and clears after the target recovery read or successful auth retry. T18 e2e covers permanent recovery, auth-pause UI, SQLite convergence, acknowledged IPC toast delivery, and undo invalidation without contacting Gmail. The seeded store has no OAuth config, so `TestSeams` (every `attn:test:*` seam lives in `src/main/testIpc.ts`, constructed disabled outside the env seam) also installs the hook that makes a reconnect click resume the seeded account — production `signIn()` stays free of test branching, and the real OAuth reconnect path is consequently unit-covered rather than e2e-covered.
- The test-only `attn:test:runLifetimeSweep` event runs the production lifetime worker against a supplied in-memory provider while retaining the real SQLite store. Use it for cursor/relaunch coverage that must never contact Gmail; assertions should pin requested formats and page tokens so the seam cannot hide a body fetch or a restart from page one.
- The test-only `attn:test:runExistenceSweep` event runs the production expiry tombstone pass against supplied complete All Mail, Spam, and Trash id sets while retaining the real SQLite store. Use it to prove ghost removal through the utility-process boundary without contacting Gmail.
- The test-only `attn:test:listMailboxThreadIds` event reads the production per-message mailbox membership query. Use it to prove seeded mixed-label threads belong to each expected system mailbox before the full M3 navigation UI exists.
- The test-only `attn:test:runFtsBackfill` event runs the production FTS backfill against the real SQLite store. It can first reset the index to the manually-upgraded-profile state (stored messages, empty index, unset `fts_cursor`) and pause after N committed batches, which is how the utility-crash spec proves the pass resumes from its persisted cursor without duplicate rows. `attn:test:searchIndexStats` runs FTS5 MATCH queries inside the utility process and reports per-query latencies plus the index's on-disk size via `dbstat`; the perf suite records both in T20-EVIDENCE.md.
- The test-only `attn:test:queryPerfStats` event times production mailbox counts, All Mail paging, and local search inside the utility process. The large-profile suite uses it to measure database work without a renderer refresh warming the handler cache before a sample.
- Composer/outbox specs share the `ComposerPage` driver in `e2e/composer.ts`: open with `openNew()`/`openReply()`, type through the editor, and send with the platform modifier, without coupling tests to composer markup. Composer state settles over IPC, so the driver's reads are retrying assertions — `expectRecipients()` polls the chips' normalized `data-email` (a chip missing that attribute fails rather than falling back to display text), `expectSaved()` requires a per-mount local revision newer than its last observation and polls until that exact revision is persisted, and `expectPending()` polls the header's user-action count. Add new reads in that shape; a one-shot snapshot passes for the wrong reason before the IPC round-trip lands.
- Time-driven main-process schedulers take the injectable `SchedulerTime` contract from `src/main/time.ts` (`now()` plus a timer factory), defaulting to `systemTime` in production. Everything time-driven takes it — `SnoozeScheduler`, `ActionExecutor`, `DraftMirrorExecutor`, `OutboxSender`, `OfflineRetryScheduler`, `HistoryPoller`, `OnDemandBodyHydrator`, `GmailClient` (token expiry plus transient-retry backoff) and its quota limiter (`gmail/quota.ts`), and the `backfill`/`lifetimeSweep`/`attachmentFlags`/`ftsBackfill` runners — and new ones do the same. Unit tests supply that dependency or Vitest fake timers; never make undo-send or outbox tests wait on wall-clock time.
- Beyond the seams called out above, specs also lean on `attn:test:` `installFakeAiProvider`, `aiProviderRequests`, `installSendProvider`, `setUndoSendDelay`, `setSyncState`, `focusThread`, `crashUtility`, `utilityState`, the `delay*` pacing seams, `failNextDraftSave`, `failOutbox`, `remoteDraft`, `setSearchWindow`, `setUpdateState`, `holdNextResponse`, `observeInvokes`, `invokeHandler`, `failNextInvoke`, and `expireReminders`; all of them live in `src/main/testIpc.ts` and are disabled outside the env seam. `holdNextResponse` parks one invoke result after main computed it so a spec can interleave a competing action without a sleep; `observeInvokes` records a channel's call arguments, `invokeHandler` calls a registered handler from main (a request whose answer nothing delivers), and `failNextInvoke` lets one invoke's real handler run — optionally with substituted arguments — and then reject. All four ride the same wrapper: every invoke channel is claimed through `ipcMain.handle` (`registerIpc`'s own `handle()` for main-owned channels, the same call in its forwarding loop for the rest), which the seam wraps and whose listeners it records — never reach into Electron's private `_invokeHandlers` from a spec.
- Shared helpers, not copies: `e2e/seams.ts` owns the `ipcMain.emit(channel, {}, …, done)` shapes (`callSeam`/`emitSeam`/`fireSeam` plus the named seams built on them), and `e2e/nav.ts` the app-driving ones (`goTo`, `openPalette`/`runPaletteCommand`, `selectedIndex`, `threadRow`, `enableAi`). Add a new helper there rather than a fourth private copy of it.
- Hidden windows never dispatch `selectionchange`, so Lexical only learns a clicked or arrowed caret from the next `beforeinput`; keydown-driven edits (Backspace, Delete, Enter) act on its last internal selection. To edit at a spot in the composer, click it and type a character first, then delete through it — Home/End/Shift+Arrow selections are invisible to the editor in the e2e harness.
- Never make a test wait on the wall clock for a product timer: `page.clock.install()` + `resume()` leaves the app running normally while letting a spec `fastForward` exactly one interval (the autocomplete debounce and cooldown are driven this way), and a released `holdNextResponse` is settled by a couple of real IPC round trips (`flushRendererIpc`), not by a sleep. A reminder that must be due at relaunch is written far in the future and then back-dated through `attn:test:expireReminders`, which updates the stored deadline without refreshing the live scheduler and reports the pending-reminder count so a spec can poll for the row it is about to expire; `boot.relaunch()` has no wait option. The remaining `waitForTimeout` calls are windows in which something must *not* happen, and each says so.
- Seeds generated at run time — large ones (the account-restore profiles, the derived perf split seed) and small derived ones (`inbox-zero.spec.ts`'s readiness seeds) — are written to the gitignored `e2e/.generated/`, not to `e2e/.artifacts/`, which CI uploads wholesale. Prefer deriving a seed that differs from a sibling by a field or two over adding another near-identical `e2e/fixtures/*.json`.
- Select on `data-testid` attributes (add them for new UI); never on Tailwind classes.

## Architecture invariants

Violating these is a correctness bug, not a style preference:

- **The renderer is sandboxed** (`contextIsolation`, no `nodeIntegration`) and never talks to Google or the filesystem. Everything crosses through the typed `contextBridge` API in `src/preload/index.ts` plus the handlers registered in `src/main/ipc.ts` — add both halves, and the channel type in `src/shared/ipc.ts`, when you add a capability.
- **Mail bodies are untrusted input.** Plain text stays in text nodes. HTML must pass through
  DOMPurify and render only in the scriptless sandbox used by `MessageBody`; never add `allow-scripts`
  or use `dangerouslySetInnerHTML` (SPEC §6). Stored attachment `inlineData` is omitted from
  `ConversationMsg`, but CID rendering deliberately returns an allowlisted image as a base64 `dataUrl`
  through the typed `mail:getInlineImage` bridge (maximum 25 MB) and assigns it inside that iframe.
  Treat the bridged value as untrusted attachment content; it is not confined to the main process.
- **Local-first:** reads and writes hit the local SQLite store and apply optimistically. Never block the UI on the network.
- **`action_queue` stores only user mail intents keyed by Gmail thread id.** Draft checkpoint/retry/delete work derives from `outbox` revisions and runs through `DraftMirrorExecutor`; never overload `action_queue.thread_id` with an outbox UUID or let best-effort draft backoff block triage.
- **Normal shutdown quiesces an active Gmail draft checkpoint before SQLite closes.** A remote draft create is not idempotent: mirror mutations are single-attempt, and `DraftMirrorExecutor.stop()` gives the current row five seconds to make its returned id durable before aborting it, awaits the canceled drain, then declines further rows. Do not turn that wait back into a fire-and-forget teardown.
- **Paged Gmail listings run on the shared cursor walk** (`src/main/sync/cursorWalk.ts`): `backfill`, `lifetimeSweep`, `attachmentFlags`, `splitMetadata`, and `ftsBackfill` all persist a `phase[:token]` cursor through it, and a new paged runner does the same. The one deliberate exception is `sync/existenceSweep.ts`: its cursor is the dedicated `thread_existence_state(phase, page_token)` row whose presence doubles as the "evidence snapshot is valid" flag, it walks three listings with independent token spaces, its one-shot expired-token reset discards evidence across all three, and it throws to its caller instead of reporting through `onError`. Do not port it; extending the skeleton to fit would change behavior its tests pin.
- **Every row is keyed by `account_id`** — the schema is multi-account-ready even though v1 ships single-account (SPEC D4).
- **The product has no runtime compatibility-migration framework.** `src/main/db/schema.ts` is the single current schema snapshot and every schema change bumps its version. Throwaway profiles may be deleted and re-synced. When a maintainer needs to preserve a real dogfood database across an additive schema bump, use the manual local-upgrade procedure below; never improvise by deleting the whole profile or its `tokens.bin`.
- Secrets live in the OS keychain via `safeStorage`; `oauth.config.json` is gitignored and must never be committed or read into a test.

## When you add a feature

- Extend the e2e suite in the same change, mirroring the feature's acceptance criteria in docs/SPEC.md §4. Untested features are not done.
- Every user-facing feature must register a command-palette command (SPEC F5) — when the palette lands (M3) its spec asserts this; keep the invariant in mind now.
- Real-Gmail paths stay out of e2e; sync-engine correctness gets unit tests against a mock `MailProvider` (M1+).
- Match the surrounding code: Biome formatting (single quotes, no semicolons, 110 cols) is enforced by `npm run lint` and a pre-commit hook.

## Environment notes

### Preserving a local dogfood database across a schema bump

This is an operator procedure for local development, not application migration code. Use it only when the schema diff is additive and data-preserving; destructive or semantic rewrites still require an explicit task-level migration design or a clean re-sync.

1. Stop every Attn/Electron development process. Never modify a database while the app may still hold it open.
2. Read the exact database path from the app's `[db] open at …` boot line. Do not guess a profile path, use a broad directory, or touch `tokens.bin`.
3. Record `PRAGMA user_version`, representative row counts, and `PRAGMA quick_check`. Create an untouched, timestamped backup beside the profile before changing the active database; include any `-wal`/`-shm` state by opening the stopped database through SQLite rather than copying a live file.
4. Diff the old and current snapshots and write down the exact task-specific DDL. Proceed manually only for changes such as adding tables, indexes, or nullable/defaulted columns that preserve every existing row.
5. Apply the DDL and `PRAGMA user_version = <new-version>` in the same `BEGIN IMMEDIATE … COMMIT` transaction. Never bump the version separately from the schema change.
6. Re-run `PRAGMA quick_check`, verify every expected table/index/column, and compare the recorded row counts. Keep the untouched backup until the upgraded app has been dogfooded successfully.
7. Relaunch normally and confirm the boot log opens the expected schema and resumes incremental history polling instead of starting a fresh backfill. If any validation fails, stop, restore the untouched backup, and either correct the DDL or re-sync.

Every task that bumps the schema must state its exact local-development DDL in the task/PR notes when the change qualifies for this procedure. Do not add a general runtime migration framework unless a separate product task explicitly calls for one.

- `npm install` runs `scripts/ensure-electron-toolchain.mjs`, which verifies better-sqlite3 actually loads **inside Electron** and self-heals what restricted networks break (Electron binary download, native-module headers) — see that script's header comment for the mechanism. Never set `ELECTRON_RUN_AS_NODE` in the environment of the app under test.
- **Claude Code on the web:** the SessionStart hook (`.claude/hooks/session-start.sh`) runs `npm install` + build so a fresh container can verify immediately. These containers block `www.electronjs.org` / `artifacts.electronjs.org`; the toolchain script routes around it via github.com + nodejs.org. **Allowlisting those two hosts in the environment's network policy would let plain `npm install` work and retire the fallback.**
- **GitHub authentication on macOS:** run `gh auth status` and other authenticated `gh` commands with host access so GitHub CLI can read credentials from the macOS Keychain. If a sandboxed authentication check fails, retry it with host access before asking the user to authenticate.

## Repository layout

```
AGENTS.md            This file — the working agreement, shared by every agent tool
.claude/             Claude Code config: CLAUDE.md (imports this file), settings, hooks
docs/SPEC.md         Product & technical spec — source of truth for behavior
docs/M1-PLAN.md      M1 task guide: triage core
docs/M2-PLAN.md      M2 task guide: composer, drafts, send, exactly-once outbox
docs/M3-PLAN.md      M3 task guide: sync restructure + find & focus
docs/M4-PLAN.md      M4 task guide: power finish (settings, snippets, follow-ups, AI drafting, packaging)
docs/M5-PLAN.md      M5 task guide: multi-account
docs/KNOWN-ISSUES.md Live triage list: open bugs, coverage gaps, refactor proposals
docs/RELEASE.md      Release runbook: workflow, secrets, feed decision, schema gate
README.md            Human onboarding: prerequisites, OAuth client, scripts
design/explorations/ Static HTML visual-direction studies
src/main/            Main process: windows, OAuth, SQLite (db/), Gmail (gmail/, sync/)
src/main/sync/tuning.ts  Mail storage, read limits, sync scheduling, and Gmail throughput defaults
src/shared/outboxTuning.ts  Composer checkpoints, send recovery, undo-send options, and retention defaults
src/renderer/src/tuning.ts  Renderer interaction timings
src/preload/         contextBridge API — the renderer's only path to the main process
src/renderer/        React UI (sandboxed)
src/shared/          Types shared across processes
e2e/                 Playwright suite + fixtures
scripts/             Toolchain repair, e2e runner
```
