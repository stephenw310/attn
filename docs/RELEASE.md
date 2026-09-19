# Release guide

Signing and the automatic-update feed are deferred. Current distribution uses source and personal builds. Use the package commands in [README.md](../README.md#build-an-installed-app). Install updates manually.

The procedure below applies if signed releases are enabled later.

## Configure the release environment

1. Choose a public GitHub repository for the update feed.
2. Set the repository variable `ATTN_RELEASE_FEED` to `owner/repo`.
3. Create a GitHub Actions environment named `release`.
4. Restrict that environment to `main` and tags that match `v*`.
5. Add the signing secrets listed below to that environment.

If `ATTN_RELEASE_FEED` is absent, the workflow uses the source repository. Installed clients read the feed without authentication. A private repository cannot serve those clients. Do not use `ATTN_ALLOW_PRIVATE_FEED` for a public release.

You can add a required reviewer to the environment if you want manual release approval. The workflow also rejects release commits that are not on `main`.

| Secret | Value |
| --- | --- |
| `CSC_LINK` | Base64-encoded Developer ID Application certificate in P12 format |
| `CSC_KEY_PASSWORD` | Password for that certificate |
| `APPLE_ID` | Apple ID for the developer account |
| `APPLE_APP_SPECIFIC_PASSWORD` | App-specific password for that Apple ID |
| `APPLE_TEAM_ID` | Apple developer team ID |
| `WIN_CSC_LINK` | Base64-encoded Windows signing certificate in PFX format |
| `WIN_CSC_KEY_PASSWORD` | Password for the Windows certificate |
| `ATTN_RELEASE_TOKEN` | Token with Contents read and write access to a separate feed repository |

`ATTN_RELEASE_TOKEN` is needed only when the feed uses another repository. The workflow otherwise uses `GITHUB_TOKEN`.

Missing macOS credentials cause the release build to fail. The release verifier rejects an unsigned Windows installer. Neither path falls back to a personal build.

## Publish a version

1. Run the required verification on `main`.

   ```sh
   npm run verify
   ```

2. If the schema changed, confirm the contiguous migration and upgrade tests. See [the schema rules](../AGENTS.md#change-the-database-schema).
3. Update the version. Replace `0.2.0` with the version you intend to release.

   ```sh
   npm version 0.2.0 --no-git-tag-version
   ```

4. Commit the version files.

   ```sh
   git add package.json package-lock.json
   git commit -m "Release 0.2.0"
   ```

5. Tag that commit.

   ```sh
   git tag v0.2.0
   ```

6. Push the commit and tag.

   ```sh
   git push origin main v0.2.0
   ```

7. Watch the **Release** workflow until publication completes.

The tag must equal `v` plus the package version. Use a `major.minor.patch` version without a prerelease suffix. The tagged commit must be on `main`.

You can also run the workflow manually for a commit on `main`. It creates the matching version tag if needed. An existing tag must point to that commit. An existing version release requires a new version.

The workflow checks the version, schema, tag, and feed. It runs `npm run verify`, then builds on macOS and Windows. It signs and notarizes the macOS app and signs the Windows installer. `package:verify --release` checks the results before upload.

The publish job creates a draft release and uploads all assets before publication. It replaces the rolling update-feed files last. Its summary contains the release URL.

## Check an installed update

1. Open **Settings**, then **About**, in a signed release build.
2. Select **Check for updates**.
3. Wait for the download to complete.
4. Select **Restart to update**, or quit and relaunch Attn.
5. Confirm the new version and the existing mail data.

Release builds check at startup and every six hours. Downloads run in the background. The app does not force a restart.

Personal builds, development builds, and isolated test builds do not construct an updater.

## Update files and schema checks

A release build includes `distribution.json` beside `app.asar`. The file declares release mode, the feed repository, and the supported database schema range.

The rolling `update-feed` release contains `latest.yml` for Windows and `latest-mac.yml` for macOS. Each file points to versioned assets and declares `requiredSchemaVersion` and `minimumSchemaVersion`.

The updater checks the local schema before download and again before installation. It rejects missing metadata or an incompatible schema. On first launch, `openDatabase()` applies all required migrations in one transaction and runs `PRAGMA quick_check` before commit.

Follow the [schema migration rules](../AGENTS.md#change-the-database-schema) when changing the stored schema.

## Release assets

For a version such as `0.2.0`, the release contains these files:

```text
Attn-0.2.0-mac-arm64.dmg
Attn-0.2.0-mac-arm64.zip
Attn-0.2.0-mac-arm64.zip.blockmap
Attn-0.2.0-mac-x64.dmg
Attn-0.2.0-mac-x64.zip
Attn-0.2.0-mac-x64.zip.blockmap
Attn-0.2.0-win-x64.exe
Attn-0.2.0-win-x64.exe.blockmap
latest-mac.yml
latest.yml
```

Users install the DMG or EXE. The updater uses ZIP files, the Windows installer, and blockmaps. The rolling `update-feed` prerelease contains only the two YAML files.

`scripts/stamp-update-feed.mjs` changes asset URLs to versioned release URLs and adds migration metadata. It rejects wrong versions, prerelease versions, missing assets, and versions no newer than the current feed.

## Build a signed release locally

Use the target operating system. Supply the signing secrets through your environment. Do not put secrets in committed scripts or command history.

Set `ATTN_DISTRIBUTION_MODE` to `release` and `ATTN_RELEASE_FEED` to the public `owner/repo`. Then run the applicable command:

```sh
npm run release:mac
npm run release:win
```

To stamp the feed after the build, replace the repository and version in this command:

```sh
npm run release:stamp-feed -- dist --assets-base https://github.com/owner/repo/releases/download/v0.2.0
```

If you publish manually, upload all versioned assets to a draft release first. Publish that release after the uploads finish. Replace the two files in `update-feed` last.
