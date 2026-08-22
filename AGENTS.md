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
| `npm run e2e:perf` | Build + generated 10,000-thread Electron profile (windowing, main private + utility heap/external/SQLite-cache memory, list/conversation/bulk/composer budgets) |
| `npm run typecheck` / `npm run lint` | Fast static passes |
| `npm run toolchain` | Repair Electron binary / native-module ABI (also runs as postinstall) |
| `npm run package:dir` | Build and verify an unpacked app for the current platform |
| `npm run package:mac` / `package:mac:all` | Build and verify macOS artifacts for one/both architectures |
| `npm run package:win` | Build and verify the Windows installer for the current architecture |
| `npm run package:verify` | Assert packaged runtime assets and native module architecture |

**Visual self-check:** the e2e suite rewrites `e2e/.artifacts/login.png`, `inbox.png`, `reading.png`, `simple-mail.png`, `label-picker.png`, `auth-paused.png`, `composer.png`, `inline-reply.png`, `draft-chip.png`, `attachments.png`, `newsletter-quote.png`, and `gmail-draft.png` (grep `e2e/*.spec.ts` for `.artifacts` when adding one, and list it here). After UI changes, inspect every affected artifact and confirm the rendering matches intent; test setup must not leave text-selection highlights in screenshots. Failure debugging: traces land in `e2e/.results/` (`npx playwright show-trace …`), and the main-process log is attached to failed tests.

## How the e2e harness works

- Signed-out tests exercise the onboarding screen. Mail-feature suites use a deterministic seeded real SQLite store, so OAuth and Gmail are never involved and the suite stays runnable with zero credentials.
- Electron windows stay hidden by default so local e2e runs do not flash or steal focus. Pass `--visible` through either e2e script (for example, `npm run e2e -- --visible`) when debugging with an OS-visible window; specs that explicitly launch with `--hidden` remain hidden.
- Specs can opt into a seeded real SQLite store with `test.use({ seed: 'fixtures/seed-inbox.json' })`; the underlying `ATTN_TEST_SEED` seam is honored only alongside `ATTN_TEST_USER_DATA`. Date seed messages with `receivedDaysAgo` (day-anchored, `receivedAt` for the wall-clock time) rather than an absolute `internalDate` — absolute stamps drift into "Older" as the repo ages, which breaks date-group assertions and makes `inbox.png` read as stale mail.
- The `boot.relaunch()` helper restarts Electron against the same userData directory and returns the new app and page, so durability tests exercise persisted state without reseeding.
- Each test boots its own app instance against a throwaway userData dir via the `ATTN_TEST_USER_DATA` seam (`src/main/index.ts`) — fresh DB, no tokens, and a developer's real `oauth.config.json` can't leak in. Under that seam the app also tees console output to `main.log` in the same dir, which is what makes boot-time lines assertable.
- Fixtures live in `e2e/electron.ts` (`app`, `page`, `userData`, `mainLog`). The boot fixture fails any test that produced renderer console errors — collected across every launch, `relaunch()` included — keep it that way.
- Seed messages may carry optional `messageId` and `references` fields for RFC threading tests. The visible `t-roadmap` fixture pins both headers plus a latest-message `Reply-To` that differs from `From`; append new fixture threads rather than reordering the existing list because triage specs depend on its indices. The test-only `attn:test:reloadSeed` main-process event replays the fixture through `persistThread` so idempotent derived data can be regression-tested; it may also receive an authoritative label array, replacing the seeded catalog and broadcasting `mail:changed` when that catalog differs so poller-driven picker refreshes can be exercised without Gmail.
- The test-only `attn:test:failNextAction` and `attn:test:failNextActionAuth` events install a seeded provider that rejects only the named thread once, serves authoritative snapshots for every fixture thread while installed, and clears after the target recovery read or successful auth retry. T18 e2e covers permanent recovery, auth-pause UI, SQLite convergence, acknowledged IPC toast delivery, and undo invalidation without contacting Gmail. The seeded store has no OAuth config, so `TestSeams` (every `attn:test:*` seam lives in `src/main/testIpc.ts`, constructed disabled outside the env seam) also installs the hook that makes a reconnect click resume the seeded account — production `signIn()` stays free of test branching, and the real OAuth reconnect path is consequently unit-covered rather than e2e-covered.
- The test-only `attn:test:runLifetimeSweep` event runs the production lifetime worker against a supplied in-memory provider while retaining the real SQLite store. Use it for cursor/relaunch coverage that must never contact Gmail; assertions should pin requested formats and page tokens so the seam cannot hide a body fetch or a restart from page one.
- The test-only `attn:test:listMailboxThreadIds` event reads the production per-message mailbox membership query. Use it to prove seeded mixed-label threads belong to each expected system mailbox before the full M3 navigation UI exists.
- Composer/outbox specs share the `ComposerPage` driver in `e2e/composer.ts`: open with `openNew()`/`openReply()`, type through the editor, and send with the platform modifier, without coupling tests to composer markup. Composer state settles over IPC, so the driver's reads are retrying assertions — `expectRecipients()` polls the chips' normalized `data-email` (a chip missing that attribute fails rather than falling back to display text), `expectSaved()` requires a per-mount local revision newer than its last observation and polls until that exact revision is persisted, and `expectPending()` polls the header's user-action count. Add new reads in that shape; a one-shot snapshot passes for the wrong reason before the IPC round-trip lands.
- Time-driven main-process schedulers take the injectable `SchedulerTime` contract from `src/main/time.ts` (`now()` plus a timer factory), defaulting to `systemTime` in production. Everything time-driven takes it — `SnoozeScheduler`, `ActionExecutor`, `DraftMirrorExecutor`, `OutboxSender`, `OfflineRetryScheduler`, `HistoryPoller`, `OnDemandBodyHydrator`, `GmailClient` (token expiry plus transient-retry backoff) and its quota limiter (`gmail/quota.ts`), and the `backfill`/`lifetimeSweep`/`attachmentFlags` runners — and new ones do the same. Unit tests supply that dependency or Vitest fake timers; never make undo-send or outbox tests wait on wall-clock time.
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
docs/KNOWN-ISSUES.md Live triage list: open bugs, coverage gaps, refactor proposals
README.md            Human onboarding: prerequisites, OAuth client, scripts
design/explorations/ Static HTML visual-direction studies
src/main/            Main process: windows, OAuth, SQLite (db/), Gmail (gmail/, sync/)
src/preload/         contextBridge API — the renderer's only path to the main process
src/renderer/        React UI (sandboxed)
src/shared/          Types shared across processes
e2e/                 Playwright suite + fixtures
scripts/             Toolchain repair, e2e runner
```
