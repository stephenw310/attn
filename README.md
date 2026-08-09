# SHC Mail (superhuman-clone)

Keyboard-first, local-first desktop email client for macOS and Windows, modeled on Superhuman's triage philosophy: sub-perceptible latency, everything on the keyboard, inbox zero as the default state.

- **[SPEC.md](SPEC.md)** — product & technical spec (source of truth, v0.4: all decisions resolved)
- **[SETUP.md](SETUP.md)** — dev setup + creating your Google OAuth client

```bash
npm install
npm run dev
```

**Current state: M0 walking skeleton.** Electron + React + TypeScript shell, two-pane inbox with `J`/`K`/`Enter`/`Esc` navigation on mock data, SQLite local store (versioned schema), and the Google OAuth PKCE flow — waiting on your `oauth.config.json` (see SETUP.md) to sync real Gmail.
