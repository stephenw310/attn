# Dev setup

## Prerequisites

- Node 20+ (developed on 24) and npm
- macOS: Xcode Command Line Tools (for the native SQLite build)
- Windows: Visual Studio Build Tools with the C++ workload

## Install & run

```bash
npm install
npm run dev
```

`npm install` downloads the Electron binary and rebuilds `better-sqlite3` against Electron's ABI (postinstall hook). If the Electron binary download was blocked (proxy/sandboxed install) the app fails with "Electron uninstall" — run `node node_modules/electron/install.js` once, then retry.

Useful scripts: `npm run typecheck` (all three tsconfigs), `npm run build` (production bundles to `out/`).

## Google OAuth client (required for real Gmail data)

v1 is deliberately "dev-mode" (SPEC §9.2): you supply your own Google OAuth client and no Google verification is involved. Until this is configured the app runs on mock data and the account chip reads "OAuth not configured".

In the [Google Cloud Console](https://console.cloud.google.com), accomplish these five things (the console UI moves around; the goals don't):

1. Create (or pick) a project.
2. **Enable the Gmail API** for that project.
3. Configure the **OAuth consent screen**: External user type, leave the app in **Testing** mode, and add your own Gmail address as a **test user**.
4. Create an **OAuth client ID** of type **Desktop app**. Copy the Client ID and Client Secret.
5. In the project root: `cp oauth.config.example.json oauth.config.json`, paste both values in. The file is gitignored — never commit it.

Restart the app and click **Sign in with Google**. The browser will show Google's "unverified app" screen — expected in dev-mode; proceed via the advanced/continue path. Tokens are stored encrypted via the OS keychain (Electron `safeStorage`), never in plaintext.

### Known constraints (v1, by design — SPEC §9)

- **Testing-mode refresh tokens expire after about 7 days**, so expect to re-authenticate roughly weekly.
- `gmail.modify` is a restricted scope: public distribution would require Google's app verification + security assessment. Out of scope for v1.
