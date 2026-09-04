# Releasing Attn

How a version reaches installed apps (T39, [SPEC §6 Packaging](SPEC.md#6-architecture)). Personal
packaging (`npm run package:*`) is unchanged and needs none of this; it produces ad-hoc-signed or
unsigned installers that never check for updates.

## How auto-update works

- A release build carries `distribution.json` beside `app.asar` declaring `mode: release`, the
  database schema version it runs, and the GitHub Releases feed (`owner/repo`). Only such a build,
  packaged and outside the e2e harness, constructs an updater (`src/main/update/`).
- The updater asks the feed on launch and every six hours, downloads in the background, and applies
  on the next quit. Nothing forces a restart. Settings → About shows the running version, the build
  kind, the feed, and the last check, with **Check for updates** and **Restart to update**; the
  command palette offers both as well.
- Each release's `latest.yml` (Windows) and `latest-mac.yml` (macOS) carries
  `requiredSchemaVersion`. The updater installs a release only when that number equals both the
  running build's schema and the local database's `user_version`, checked before download and again
  before install. A release for a newer schema is reported in About as needing a database upgrade
  and never installs on its own — the app has no runtime migration framework, so a schema bump is
  a separate manual procedure ([AGENTS.md](../AGENTS.md#preserving-a-local-dogfood-database-across-a-schema-bump)).
- macOS updates are Squirrel.Mac ZIPs and must be Developer ID signed and notarized; Windows
  updates are the NSIS installer, Authenticode signed. `npm run package:verify -- --release` checks
  both before anything is uploaded.

## One-time setup

1. **Decide the feed repository.** electron-updater reads a GitHub Releases feed anonymously, so
   installed apps cannot update from a private repository. Either make this repository public or
   create a public one (for example `stephenw310/attn-releases`) that holds only releases. Record
   the choice as the repository variable `ATTN_RELEASE_FEED` (`owner/repo`); it defaults to this
   repository. The workflow refuses a private feed unless the variable `ATTN_ALLOW_PRIVATE_FEED` is
   `true`, which is only useful for a private test feed with a token-authenticated updater you have
   not built.
2. **Add the signing secrets** (Settings → Secrets and variables → Actions → Secrets):

   | Secret | What |
   |---|---|
   | `CSC_LINK` | Developer ID Application certificate as a base64 `.p12`: `base64 -i cert.p12 \| pbcopy` |
   | `CSC_KEY_PASSWORD` | Its export password |
   | `APPLE_ID` | The Apple ID that owns the Developer account |
   | `APPLE_APP_SPECIFIC_PASSWORD` | An app-specific password for that Apple ID (appleid.apple.com) |
   | `APPLE_TEAM_ID` | The 10-character team id |
   | `WIN_CSC_LINK` | The Windows code-signing certificate as a base64 `.pfx` |
   | `WIN_CSC_KEY_PASSWORD` | Its password |
   | `ATTN_RELEASE_TOKEN` | Only when the feed is another repository: a fine-grained token with *Contents: read and write* on it |

   Missing macOS credentials fail the macOS build inside electron-builder; missing Windows
   credentials produce an unsigned installer that the release verifier rejects. Neither can fall
   back to a personal artifact.

## Every release

1. Make sure `main` is green (`npm run verify`) and that the database schema version in
   `src/main/db/schema.ts` is the one the installed base runs. If it changed, this release cannot
   auto-install anywhere; say so in the release notes and follow the manual upgrade procedure.
2. Bump the version and tag it:

   ```bash
   npm version 0.2.0 --no-git-tag-version     # writes package.json + package-lock.json
   git commit -am "Release 0.2.0"
   git tag v0.2.0
   git push origin main v0.2.0
   ```

   The tag must be `v` plus the package.json version; the workflow fails otherwise. Running the
   **Release** workflow by hand from a branch is also allowed: it releases that commit under
   `v<package.json version>` and creates the tag.
3. Watch the **Release** workflow: `prepare` (version, schema, feed checks) → `build` on
   `macos-latest` and `windows-latest` (unit tests, package, sign, notarize, `package:verify --release`)
   → `publish` (stamp `requiredSchemaVersion`, create a draft release, upload every asset, publish).
   The step summary prints the stamped feed files and the release URL.
4. Installed apps pick it up within six hours, or immediately from **Check for updates**. To
   watch one: open Settings → About on a release build, check, and confirm the status line moves
   from "Downloading" to "downloaded"; quit and relaunch to land on the new version.

The release is created as a draft and published only after every asset is uploaded, so no app ever
sees a half-uploaded release. A tag that already has a release is refused; bump the version instead.

## What the feed contains

```
Attn-0.2.0-mac-arm64.dmg   Attn-0.2.0-mac-arm64.zip   Attn-0.2.0-mac-arm64.zip.blockmap
Attn-0.2.0-mac-x64.dmg     Attn-0.2.0-mac-x64.zip     Attn-0.2.0-mac-x64.zip.blockmap
Attn-0.2.0-win-x64.exe     Attn-0.2.0-win-x64.exe.blockmap
latest-mac.yml             latest.yml
```

The DMG and EXE are what people download by hand; the ZIPs and the two `.yml` files are what the
updater reads. `scripts/stamp-update-feed.mjs` appends `requiredSchemaVersion: <n>` to each `.yml`
and refuses a file whose `version:` is not package.json's or whose assets were not built.

## Building a release locally

The same scripts run on a Mac or Windows machine with the credentials in the environment:

```bash
ATTN_DISTRIBUTION_MODE=release ATTN_RELEASE_FEED=owner/repo \
CSC_LINK=... CSC_KEY_PASSWORD=... APPLE_ID=... APPLE_APP_SPECIFIC_PASSWORD=... APPLE_TEAM_ID=... \
npm run release:mac
npm run release:stamp-feed -- dist      # then upload dist/* to the GitHub release yourself
```

Uploading by hand is the workflow's `publish` job done manually; keep the draft-then-publish order.
