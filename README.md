# Attn

Keyboard-first, local-first desktop email client for macOS and Windows, modeled on Superhuman's triage philosophy: sub-perceptible latency, everything on the keyboard, inbox zero as the default state.

- **[SPEC.md](SPEC.md)** — product & technical spec (source of truth, v0.4: all decisions resolved)
- **[SETUP.md](SETUP.md)** — dev setup + creating your Google OAuth client

```bash
npm install
npm run dev
```

Verification: `npm run verify` — typecheck + lint + build + Playwright e2e against the built app (headless-safe, no OAuth required). See SETUP.md and CLAUDE.md.

**Current state: M0 walking skeleton.** Electron + React + TypeScript shell, two-pane inbox with `J`/`K`/`Enter`/`Esc` navigation, SQLite local store (versioned schema), Google OAuth (PKCE loopback, keychain-encrypted tokens), and a quota-aware Gmail backfill rendering your real inbox.
