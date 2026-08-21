# Attn

Keyboard-first, local-first desktop email client for macOS and Windows, modeled on Superhuman's triage philosophy: sub-perceptible latency, everything on the keyboard, inbox zero as the default state.

**Current state: M1 feature work is complete; M2 (mail out) feature work and its engineering hardening pass are complete, with manual sign-off evidence still open.** The Dispatch full-width list ⇄ full-window conversation flow includes keyboard triage and bulk actions, durable offline replay, snooze scheduling, incremental Gmail polling with label-catalog refresh and a visible sync status, sanitized HTML/attachment rendering, background lifecycle, notifications, unread badges, and personal-build packaging. M2 added the full-window composer with crash-safe local drafts, inline reply/reply-all/forward drafting, rich content with a zero-formatting-loss invariant, two-way Gmail Drafts sync, attachments (spooled locally, mirrored to Gmail), send with undo send behind an exactly-once outbox, self-healing failed triage actions, on-demand body hydration, and a lifetime header sweep with the full staged backfill (inbox → bodies → drafts → all-mail → spam → trash → reconcile). T20 adds a windowed 10k inbox, checked interaction/memory budgets, weighted Gmail quota pacing, and structured bootstrap telemetry. Still open before M2 sign-off: the real-Gmail evidence matrix, a one-week sole-client dogfood run, and the real-OS notification click-through smoke — see [the evidence ledger](docs/T20-EVIDENCE.md).

- **[docs/SPEC.md](docs/SPEC.md)** — product & technical spec, the source of truth for behavior (v0.15)
- **[docs/M1-PLAN.md](docs/M1-PLAN.md)** — shipped M1 task record and remaining exit checklist
- **[docs/M2-PLAN.md](docs/M2-PLAN.md)** — M2 implementation plan: pre-M2 refactors, composer, drafts, send + undo send, exactly-once outbox, and the M2 exit checklist
- **[docs/M3-PLAN.md](docs/M3-PLAN.md)** — M3 opening block: utility-process sync, per-message labels, expiry-recovery tombstones; feature tasks (search, mailboxes, splits, themes, palette) still to be planned
- **[docs/REVIEW-2026-08-16.md](docs/REVIEW-2026-08-16.md)** — review of `main` at the end of M2 feature work: verified invariants, bugs (fixed and open), doc corrections, refactor proposals, and the M2 close-out / M3 start checklist
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

The app starts on its Google sign-in screen. Connecting a real inbox requires the one-time
[Google OAuth client](#google-oauth-client-for-real-gmail-data) setup below.

## Verification

```bash
npm run verify
```

Typecheck → lint/format → unit tests → production build → Playwright end-to-end tests that drive the **real built Electron app** (main process, SQLite, preload bridge, IPC, keyboard loop). The suite needs no Google credentials: signed-out tests cover onboarding, while mail features use a deterministic seeded SQLite store in throwaway user-data directories. It uses Xvfb automatically on display-less Linux. GitHub Actions runs the same gates as three jobs: static checks + unit tests + build, Electron smoke, and the performance suite.

| Script | What it does |
|---|---|
| `npm run verify` | The full gate — run this before calling a change done |
| `npm run test:unit` | Pure main/renderer module tests |
| `npm run e2e` | Build + end-to-end tests |
| `npm run e2e:only` | End-to-end tests without rebuilding (only when `out/` is current) |
| `npm run e2e:perf` | Build, generate the 10,000-thread seed, and enforce list/composer budgets |
| `npm run typecheck` · `npm run lint` | Fast static passes |
| `npm run build` | Production bundles into `out/` |
| `npm run toolchain` | Repair the Electron binary / native-module setup |

The e2e suite writes visual-review screenshots under `e2e/.artifacts/` — `login.png`, `inbox.png`, `reading.png`, `simple-mail.png`, `label-picker.png`, `auth-paused.png`, `composer.png`, `inline-reply.png`, `draft-chip.png`, `attachments.png`, `newsletter-quote.png`, and `gmail-draft.png` (the authoritative list is in AGENTS.md); failures leave Playwright traces in `e2e/.results/` (`npx playwright show-trace <path>`).

## Package & install locally

Packaging uses `electron-builder` and writes installable artifacts to `dist/`. Build on the target
operating system so Electron and `better-sqlite3` use the correct native architecture.

```bash
# Fast unpacked app for packaging smoke tests
npm run package:dir

# macOS: DMG + ZIP for the current Mac architecture
npm run package:mac

# Windows: NSIS installer for the current Windows architecture
npm run package:win
```

On macOS, open the generated `.dmg` in `dist/` and drag **Attn** to Applications. On Windows, run
the generated `.exe` in `dist/`. macOS personal builds are ad-hoc signed rather than Developer ID
signed or notarized. Windows personal builds are unsigned and may trigger a Microsoft Defender
SmartScreen warning. Public signing, notarization, and GitHub Releases auto-update remain M4 work.

The `Package desktop apps` GitHub Actions workflow builds both Apple Silicon and Intel macOS
artifacts plus the Windows installer only when manually dispatched. It retains the non-release
installers as workflow artifacts for 14 days.

For a packaged app using real Gmail data, keep `oauth.config.json` outside the installed app in its
per-user data directory, then restart Attn:

- macOS: `~/Library/Application Support/Attn/oauth.config.json`
- Windows: `%APPDATA%\Attn\oauth.config.json`

## Google OAuth client (for real Gmail data)

v1 is deliberately "dev-mode" (SPEC §9.2): you supply your own Google OAuth client, and no Google app verification is involved. Until this is configured, the sign-in screen links the missing setup to these instructions and does not expose an inbox.

In the [Google Cloud Console](https://console.cloud.google.com), accomplish these five things (the console UI moves around; the goals don't):

1. Create (or pick) a project.
2. **Enable the Gmail API** for that project.
3. Configure the **OAuth consent screen**: External user type, leave the app in **Testing** mode, and add your own Gmail address as a **test user**.
4. Create an **OAuth client ID** of type **Desktop app**. Copy the Client ID and Client Secret.
5. In the project root: `cp oauth.config.example.json oauth.config.json`, then paste both values in. That file is gitignored — never commit it. The example's `quota_units_per_minute` is Google's post-1-May-2026 per-user project limit (6,000); set it to the actual limit shown for your project if you have customized it. Attn's weighted scheduler uses the [authoritative Gmail quota costs and limits](https://developers.google.com/workspace/gmail/api/reference/quota).

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
