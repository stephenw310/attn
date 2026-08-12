# Attn

Keyboard-first, local-first desktop email client for macOS and Windows, modeled on Superhuman's triage philosophy: sub-perceptible latency, everything on the keyboard, inbox zero as the default state.

**Current state: M1 feature implementation complete; exit audit in progress.** The Dispatch full-width list ⇄ on-demand conversation split now includes keyboard triage and bulk actions, durable offline replay, snooze scheduling, incremental Gmail polling, sanitized HTML/attachment rendering, background lifecycle, notifications, and unread badges. M2 starts after the remaining manual and engineering closeout checks in the M1 plan.

- **[docs/SPEC.md](docs/SPEC.md)** — product & technical spec, the source of truth for behavior (v0.11)
- **[docs/M1-PLAN.md](docs/M1-PLAN.md)** — shipped M1 task record and remaining exit checklist
- **[AGENTS.md](AGENTS.md)** — working agreement for coding agents (verification contract, test harness, conventions). `.claude/CLAUDE.md` imports it, so Claude Code picks it up automatically; other tools read it directly.

## Prerequisites

- **Node 22.12+** (developed on 24) and npm — better-sqlite3 and Electron's tooling require ≥ 22.12
- **macOS:** Xcode Command Line Tools
- **Windows:** Visual Studio Build Tools with the C++ workload

Both native toolchains are only needed if a native module has to be compiled from source; see [Install](#install--run) below.

## Install & run

```bash
npm install
npm run dev
```

`npm install` downloads Electron and then verifies that `better-sqlite3` actually loads *inside* Electron (postinstall: `scripts/ensure-electron-toolchain.mjs`). better-sqlite3 ships Node-API prebuilds, so normally nothing is compiled. The script rebuilds only if that check fails, and on restricted networks — where Electron's binary and header hosts are blocked — it self-heals using github.com and nodejs.org. If an install ever ends up half-broken, `npm run toolchain` re-runs the repair and reports what it did.

The app starts on mock data. Wiring it to a real inbox is the [Google OAuth client](#google-oauth-client-for-real-gmail-data) section below.

## Verification

```bash
npm run verify
```

Typecheck → lint/format → unit tests → production build → Playwright end-to-end tests that drive the **real built Electron app** (main process, SQLite, preload bridge, IPC, keyboard loop). The suite needs no Google credentials: it runs signed out against mock data in throwaway user-data directories, and uses Xvfb automatically on display-less Linux. GitHub Actions currently runs static/build, Electron smoke, and performance jobs separately; adding the unit step to CI is an explicit M1 exit item.

| Script | What it does |
|---|---|
| `npm run verify` | The full gate — run this before calling a change done |
| `npm run test:unit` | Pure main/renderer module tests |
| `npm run e2e` | Build + end-to-end tests |
| `npm run e2e:only` | End-to-end tests without rebuilding (only when `out/` is current) |
| `npm run typecheck` · `npm run lint` | Fast static passes |
| `npm run build` | Production bundles into `out/` |
| `npm run toolchain` | Repair the Electron binary / native-module setup |

The e2e suite writes `inbox.png`, `reading.png`, `simple-mail.png`, and `label-picker.png` under `e2e/.artifacts/`; failures leave Playwright traces in `e2e/.results/` (`npx playwright show-trace <path>`).

## Google OAuth client (for real Gmail data)

v1 is deliberately "dev-mode" (SPEC §9.2): you supply your own Google OAuth client, and no Google app verification is involved. Until this is configured, the app runs on mock data and the account chip reads "OAuth not configured".

In the [Google Cloud Console](https://console.cloud.google.com), accomplish these five things (the console UI moves around; the goals don't):

1. Create (or pick) a project.
2. **Enable the Gmail API** for that project.
3. Configure the **OAuth consent screen**: External user type, leave the app in **Testing** mode, and add your own Gmail address as a **test user**.
4. Create an **OAuth client ID** of type **Desktop app**. Copy the Client ID and Client Secret.
5. In the project root: `cp oauth.config.example.json oauth.config.json`, then paste both values in. That file is gitignored — never commit it.

Restart the app and click **Sign in with Google**. The browser will show Google's "unverified app" screen — expected in dev-mode; proceed via the advanced/continue path. Tokens are encrypted through the OS keychain (Electron `safeStorage`), never stored in plaintext.

### Known constraints (v1, by design — SPEC §9)

- **Testing-mode refresh tokens expire after about 7 days**, so expect to re-authenticate roughly weekly.
- `gmail.modify` is a restricted scope: public distribution would require Google's app verification plus a security assessment. Out of scope for v1.

## Repository layout

```
docs/SPEC.md         Product & technical spec — the source of truth
AGENTS.md            Working agreement for coding agents (.claude/CLAUDE.md imports it)
design/explorations/ Static HTML visual-direction studies
src/main/            Electron main process: windows, OAuth, SQLite, Gmail sync
src/preload/         contextBridge API — the renderer's only path to the main process
src/renderer/        React UI (sandboxed; no Node access)
src/shared/          Types shared across processes
e2e/                 Playwright suite driving the built app
scripts/             Toolchain repair + e2e runner
```
