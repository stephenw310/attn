# AGENTS.md

Working agreement for coding agents on **Attn** — a keyboard-first, local-first desktop email client (Electron + React + TypeScript + SQLite) in the Dispatch visual direction (full-width list ⇄ full-window conversation). **M1 is implemented and audit-clean except for two human-run smokes tracked in `docs/M1-PLAN.md`; `docs/M2-PLAN.md` is the guide for the milestone now starting (composer, drafts, send + undo send, exactly-once outbox).**

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
| `npm run test:unit` | Pure-module unit tests across main + renderer (no Electron-ABI SQLite imports) |
| `npm run e2e` | Build + e2e only |
| `npm run e2e:only` | E2e without rebuilding — **only** when `out/` already matches `src/` |
| `npm run e2e:only -- --grep <pattern>` | One test while iterating |
| `npm run typecheck` / `npm run lint` | Fast static passes |
| `npm run toolchain` | Repair Electron binary / native-module ABI (also runs as postinstall) |
| `npm run package:dir` | Build and verify an unpacked app for the current platform |
| `npm run package:mac` / `package:mac:all` | Build and verify macOS artifacts for one/both architectures |
| `npm run package:win` | Build and verify the Windows installer for the current architecture |
| `npm run package:verify` | Assert packaged runtime assets and native module architecture |

**Visual self-check:** the e2e suite rewrites `e2e/.artifacts/login.png`, `inbox.png`, `reading.png`, `simple-mail.png`, and `label-picker.png`. After UI changes, inspect every affected artifact and confirm the rendering matches intent; test setup must not leave text-selection highlights in screenshots. Failure debugging: traces land in `e2e/.results/` (`npx playwright show-trace …`), and the main-process log is attached to failed tests.

## How the e2e harness works

- Signed-out tests exercise the onboarding screen. Mail-feature suites use a deterministic seeded real SQLite store, so OAuth and Gmail are never involved and the suite stays runnable with zero credentials.
- Electron windows stay hidden by default so local e2e runs do not flash or steal focus. Pass `--visible` through either e2e script (for example, `npm run e2e -- --visible`) when debugging with an OS-visible window; specs that explicitly launch with `--hidden` remain hidden.
- Specs can opt into a seeded real SQLite store with `test.use({ seed: 'fixtures/seed-inbox.json' })`; the underlying `ATTN_TEST_SEED` seam is honored only alongside `ATTN_TEST_USER_DATA`. Date seed messages with `receivedDaysAgo` (day-anchored, `receivedAt` for the wall-clock time) rather than an absolute `internalDate` — absolute stamps drift into "Older" as the repo ages, which breaks date-group assertions and makes `inbox.png` read as stale mail.
- The `boot.relaunch()` helper restarts Electron against the same userData directory and returns the new app and page, so durability tests exercise persisted state without reseeding.
- Each test boots its own app instance against a throwaway userData dir via the `ATTN_TEST_USER_DATA` seam (`src/main/index.ts`) — fresh DB, no tokens, and a developer's real `oauth.config.json` can't leak in. Under that seam the app also tees console output to `main.log` in the same dir, which is what makes boot-time lines assertable.
- Fixtures live in `e2e/electron.ts` (`app`, `page`, `userData`, `mainLog`). The boot fixture fails any test that produced renderer console errors — collected across every launch, `relaunch()` included — keep it that way.
- Select on `data-testid` attributes (add them for new UI); never on Tailwind classes.

## Architecture invariants

Violating these is a correctness bug, not a style preference:

- **The renderer is sandboxed** (`contextIsolation`, no `nodeIntegration`) and never talks to Google or the filesystem. Everything crosses through the typed `contextBridge` API in `src/preload/index.ts` plus an `ipcMain.handle` in `src/main/index.ts` — add both halves, and the type in `src/shared/`, when you add a capability.
- **Mail bodies are untrusted input.** Plain text stays in text nodes. HTML must pass through
  DOMPurify and render only in the scriptless sandbox used by `MessageBody`; never add `allow-scripts`
  or use `dangerouslySetInnerHTML` (SPEC §6). Stored attachment `inlineData` is omitted from
  `ConversationMsg`, but CID rendering deliberately returns an allowlisted image as a base64 `dataUrl`
  through the typed `mail:getInlineImage` bridge (maximum 10 MB) and assigns it inside that iframe.
  Treat the bridged value as untrusted attachment content; it is not confined to the main process.
- **Local-first:** reads and writes hit the local SQLite store and apply optimistically. Never block the UI on the network.
- **Every row is keyed by `account_id`** — the schema is multi-account-ready even though v1 ships single-account (SPEC D4).
- Secrets live in the OS keychain via `safeStorage`; `oauth.config.json` is gitignored and must never be committed or read into a test.

## When you add a feature

- Extend the e2e suite in the same change, mirroring the feature's acceptance criteria in docs/SPEC.md §4. Untested features are not done.
- Every user-facing feature must register a command-palette command (SPEC F5) — when the palette lands (M3) its spec asserts this; keep the invariant in mind now.
- Real-Gmail paths stay out of e2e; sync-engine correctness gets unit tests against a mock `MailProvider` (M1+).
- Match the surrounding code: Biome formatting (single quotes, no semicolons, 110 cols) is enforced by `npm run lint` and a pre-commit hook.

## Environment notes

- `npm install` runs `scripts/ensure-electron-toolchain.mjs`, which verifies better-sqlite3 actually loads **inside Electron** and self-heals what restricted networks break (Electron binary download, native-module headers) — see that script's header comment for the mechanism. Never set `ELECTRON_RUN_AS_NODE` in the environment of the app under test.
- **Claude Code on the web:** the SessionStart hook (`.claude/hooks/session-start.sh`) runs `npm install` + build so a fresh container can verify immediately. These containers block `www.electronjs.org` / `artifacts.electronjs.org`; the toolchain script routes around it via github.com + nodejs.org. **Allowlisting those two hosts in the environment's network policy would let plain `npm install` work and retire the fallback.**

## Repository layout

```
AGENTS.md            This file — the working agreement, shared by every agent tool
.claude/             Claude Code config: CLAUDE.md (imports this file), settings, hooks
docs/SPEC.md         Product & technical spec — source of truth for behavior
docs/M1-PLAN.md      Shipped M1 task record + the two remaining exit smokes
docs/M2-PLAN.md      Current milestone: refactors + composer/outbox task guide
README.md            Human onboarding: prerequisites, OAuth client, scripts
design/explorations/ Static HTML visual-direction studies
src/main/            Main process: windows, OAuth, SQLite (db/), Gmail (gmail/, sync/)
src/preload/         contextBridge API — the renderer's only path to the main process
src/renderer/        React UI (sandboxed)
src/shared/          Types shared across processes
e2e/                 Playwright suite + fixtures
scripts/             Toolchain repair, e2e runner
```
