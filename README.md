# Attn

Keyboard-first, local-first desktop email client for macOS and Windows, modeled on Superhuman's triage philosophy: sub-perceptible latency, everything on the keyboard, inbox zero as the default state.

- **[SPEC.md](SPEC.md)** — product & technical spec (source of truth, v0.7)
- **[SETUP.md](SETUP.md)** — dev setup + creating your Google OAuth client

```bash
npm install
npm run dev
```

Verification: `npm run verify` — typecheck + lint/format + build + Playwright smoke tests against the built app. The smoke suite needs no OAuth credentials; see SETUP.md.

**Current state: M1 triage core in progress.** The Dispatch list ⇄ conversation-overlay flow is implemented with `J`/`K`/`Enter`/`Esc` navigation, SQLite local storage, Google OAuth (PKCE loopback, keychain-encrypted tokens), and quota-aware Gmail backfill.
