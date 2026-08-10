# CLAUDE.md

Attn — keyboard-first, local-first desktop email client (Electron + React + TS + SQLite), in the Dispatch visual direction (list ⇄ conversation overlay).
**SPEC.md is the source of truth** for product behavior; SETUP.md covers dev setup. Currently at M1 (triage core) in progress.

## Verification contract

**A change is not done until `npm run verify` is green.** Run it before claiming completion, committing, or pushing.

```
npm run verify     # typecheck (3 project tsconfigs) + biome ci + build + e2e
```

The e2e suite (Playwright) drives the **real built Electron app** — main process, SQLite, preload bridge, IPC, and keyboard loop — headless. On display-less Linux it wraps itself in xvfb automatically; `--no-sandbox` is added automatically when running as root/CI.

| Command | Use |
|---|---|
| `npm run verify` | The full gate — the definition of done |
| `npm run e2e` | Build + e2e only |
| `npm run e2e:only` | E2e without rebuilding — **only** when `out/` already matches `src/` |
| `npm run e2e:only -- --grep <pattern>` | One test while iterating |
| `npm run typecheck` / `npm run lint` | Fast static passes |
| `npm run toolchain` | Repair Electron binary / native-module ABI (auto-runs as postinstall) |

**Visual self-check:** every e2e run rewrites `e2e/.artifacts/inbox.png` (full app window). After UI changes, read that file and confirm the rendering matches intent. Failure debugging: traces land in `e2e/.results/` (`npx playwright show-trace …`); the main-process log is attached to failed tests.

## How the e2e harness works

- Tests run **signed out**, on the deterministic mock inbox (`src/renderer/src/mockData.ts`). OAuth/Gmail are never needed; the suite must stay runnable with zero credentials.
- Each test boots its own app instance against a throwaway userData dir via the `ATTN_TEST_USER_DATA` env seam (`src/main/index.ts`) — fresh DB, no tokens, and a developer's real `oauth.config.json` can't leak in.
- Fixtures live in `e2e/electron.ts` (`app`, `page`, `userData`, `mainLog`). The `page` fixture fails any test that produced renderer console errors — keep it that way.
- Select on `data-testid` attributes (add them for new UI); never on Tailwind classes.

## When you add a feature

- Extend the e2e suite in the same change, mirroring the feature's acceptance criteria in SPEC.md §4. Untested features are not done.
- Every user-facing feature must register a command-palette command (SPEC F5) — when the palette lands (M3), its spec asserts this; keep the invariant in mind now.
- Real-Gmail paths stay out of e2e; sync-engine correctness gets unit tests against a mock `MailProvider` (M1+).

## Environment notes (Claude Code on the web)

- The SessionStart hook (`.claude/hooks/session-start.sh`) runs `npm install` + build. `postinstall` is `scripts/ensure-electron-toolchain.mjs`: it verifies better-sqlite3 actually loads **inside Electron** and self-heals the two things restricted networks break (Electron binary download, native-module headers) — see that script's header for the mechanism.
- This container's egress policy blocks `www.electronjs.org` / `artifacts.electronjs.org` (Electron's headers host). The toolchain script works around it using github.com + nodejs.org. **Allowlisting those two electronjs.org hosts in the environment's network policy would let plain `npm install` work and retire the fallback.**
- Never set `ELECTRON_RUN_AS_NODE` in the environment of the app under test.
