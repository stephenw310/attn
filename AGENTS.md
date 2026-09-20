# Development guide for coding agents

Attn is a desktop Gmail client for macOS and Windows. It uses Electron, React, TypeScript, and SQLite.

This file contains the shared development rules. `.claude/CLAUDE.md` imports this file. Put project rules here, not in separate instructions for each agent tool. Keep verification requirements here and test procedures in [docs/TESTING.md](docs/TESTING.md). Link to those sections instead of copying them into other guides.

## Start here

Use [README.md](README.md) for setup and product usage. Before changing behavior, read the relevant section of [docs/SPEC.md](docs/SPEC.md). Consult [docs/KNOWN-ISSUES.md](docs/KNOWN-ISSUES.md) when investigating a defect. Use [docs/TESTING.md](docs/TESTING.md) for fixtures and test diagnosis, and [docs/RELEASE.md](docs/RELEASE.md) for packaging or releases. Inspect the code and tests affected by the request. Run `npm install` when dependencies are absent.

You need Node.js 22.12 or later. You do not need Google credentials to build or test. Do not read a developer's `oauth.config.json` or token files for a test. Do not use a developer's personal mail profile.

## Code structure

| Path | Purpose |
| --- | --- |
| `src/renderer/src/` | React views, hooks, command registry, and composer |
| `src/preload/index.ts` | Typed bridge exposed to the renderer |
| `src/main/index.ts` | Application startup, windows, and shutdown |
| `src/main/ipc.ts` | Main-process IPC registration and forwarding |
| `src/main/service/` | Utility process, supervisor, and request handlers |
| `src/shared/ipc.ts` | Typed IPC channel contract shared across processes |
| `site/` | Static landing site for GitHub Pages: home page, privacy policy, and sign-in warning |

## Process boundaries

The renderer is sandboxed. Keep `contextIsolation` enabled and `nodeIntegration` disabled. The renderer must not access Google or the filesystem directly.

The renderer calls the typed preload bridge. Main handles native operations and forwards store operations to the utility process. The utility process owns the SQLite connection, mail reads, sync workers, action execution, drafts, and sends. Do not add a fallback database connection in main.

For a new IPC capability, update these parts together:

- The channel types in `src/shared/ipc.ts`.
- The bridge in `src/preload/index.ts`.
- The registration in `src/main/ipc.ts` and the applicable handler.

Validate untrusted arguments at the process boundary. Keep local reads independent of network availability. Apply mail changes to SQLite first and update the UI optimistically.

## Account isolation

Scope account-owned rows and queries by `account_id`. The UI shows one active account. Other signed-in accounts continue to sync and send in the background.

Preserve account ownership across asynchronous work. Ignore stale results after an account switch, removal, or authentication change. Use the isolation tests in `src/main/db/isolation.test.ts` when you add a read query.

## Mail and credential security

Mail bodies and attachments are untrusted input.

- Put plain text in text nodes.
- Pass HTML through DOMPurify before display or serialization.
- Render mail HTML only in the existing scriptless sandbox.
- Do not add `allow-scripts` or use `dangerouslySetInnerHTML`.
- Keep external-link checks and remote-image authorization in main.
- Preserve sanitization when you import or restore opaque composer content.

`ConversationMsg` omits stored attachment `inlineData`. The `mail:getInlineImage` bridge can return an allowlisted image as a base64 `dataUrl`. The size limit is 25 MB. Treat that value as untrusted attachment content when you assign it inside the frame.

Store OAuth tokens and AI provider keys through `safeStorage`. Never commit credentials or read them into test fixtures.

## Durable actions and drafts

`action_queue` stores user mail actions keyed by Gmail thread ID. Do not put outbox UUIDs or draft checkpoint work in that queue.

Draft checkpoint, retry, and delete work derives from outbox revisions. `DraftMirrorExecutor` runs that work independently, so draft retry delays cannot block mail actions.

A Gmail draft create is not idempotent. Keep mirror mutations single-attempt. During normal shutdown, await `DraftMirrorExecutor.stop()` before SQLite closes. The active row has until the `MIRROR_STOP_TIMEOUT_MS` deadline to save its returned remote ID. After that deadline, the executor aborts and awaits cancellation. It must not start another row during shutdown.

Preserve send recovery and the `needs-review` state. Do not retry an uncertain remote send as a new send without proof that the first send failed.

## Sync and timers

Use `src/main/sync/cursorWalk.ts` for new paged sync workers. Backfill, lifetime headers, attachment flags, split metadata, and FTS backfill already use this shared code.

Keep the dedicated implementation in `sync/existenceSweep.ts`. Its state row also marks whether the evidence snapshot is valid. It walks All Mail, Spam, and Trash with separate page tokens. An expired-token reset discards all three evidence sets. It throws errors to its caller. These differences are required behavior.

Give time-driven code the injectable `SchedulerTime` contract from `src/main/time.ts`. Use `systemTime` in production. Tests use an injected clock or Vitest fake timers. Do not make tests wait for undo-send or retry deadlines on the wall clock.

Compile-time defaults live in these files:

- `src/main/sync/tuning.ts`: mail windows, limits, polling, retries, and Gmail quota policy.
- `src/shared/outboxTuning.ts`: draft checkpoints, send recovery, shutdown deadlines, and retention.
- `src/renderer/src/tuning.ts`: search, autocomplete, keyboard, and toast delays.

These defaults require a rebuild. Preserve explicit options and saved preferences that override them. Keep protocol constants, schema versions, MIME rules, and security limits with their implementation.

## Change the database schema

Every schema change requires an automatic migration. `schema.ts` defines fresh profiles. `migrations.ts` upgrades existing profiles through an immutable, ordered registry.

1. Edit `CURRENT_SCHEMA` in `src/main/db/schema.ts`.
2. Increment `CURRENT_SCHEMA_VERSION` by one.
3. Append exactly one contiguous step to `SCHEMA_MIGRATIONS` in `src/main/db/migrations.ts`.
4. Add representative old data and upgrade assertions to `src/main/db/schemaUpgrade.test.ts`.
5. Verify both a fresh profile and an upgraded profile.

Preserve existing rows and local-only data. If a table must be replaced, copy retained data within the migration transaction.

Do not rewrite a released migration, update `user_version` outside the migration transaction, or require a profile reset. Do not provide manual SQL as the user upgrade procedure.

`openDatabase()` applies all skipped steps in one transaction. It runs `PRAGMA quick_check` before commit. Keep the contiguous-path test from `MINIMUM_MIGRATABLE_SCHEMA_VERSION` to the current schema.

## Add or change a feature

Update the behavior and acceptance criteria in `docs/SPEC.md` when needed. Add end-to-end coverage for behavior that requires full-app verification. Expose new user-invoked actions in the command palette where a command makes sense. Cosmetic changes and passive indicators do not require new commands.

Keep real Gmail calls out of end-to-end tests. Test sync behavior against a mock `MailProvider`. Use the real temporary SQLite store where persistence matters.

Match the surrounding code. Biome enforces single quotes, no semicolons, and a 110-column line width. The pre-commit hook also checks formatting.

Use `data-testid` for end-to-end selectors. Do not select Tailwind classes. Use the [shared test drivers](docs/TESTING.md#shared-drivers) for reusable E2E operations.

Write documentation with STE-style instructions. Use active voice, one instruction per sentence, and consistent terms. Keep procedures near 20 words per sentence. Remove filler and promotional language.

## Verify the change

This section defines the required checks. Use [the test guide](docs/TESTING.md#choose-a-command) for commands, fixtures, and failure diagnosis.

- For ordinary code changes, `npm run verify:fast` and the affected E2E specs must pass before completion, commit, or push.
- For IPC, startup, shared fixtures, dependencies, build configuration, database schema or migrations, account isolation, mail or credential security, send recovery, and other broadly used infrastructure changes, the complete `npm run verify` suite must pass before completion, commit, or push.
- For documentation-only or instruction-only changes, check the edited content and links. Run application checks if executable examples or behavior change.

Rerun affected checks after fixes. Fix failures caused by the requested change without asking at each step. Report failures and verification limits without claiming success.

After a UI change, inspect every affected screenshot in each affected theme. Confirm the layout and colors. See [screenshot inspection](docs/TESTING.md#inspect-failures-and-screenshots) for the procedure.

## Environment notes

Use [the setup guide](README.md#get-started) to install dependencies and [the test guide](docs/TESTING.md#electron-fixtures) for Electron test environment details.

On macOS, authenticated `gh` commands need host access to the Keychain. If authentication fails in a sandbox, retry with host access before you ask the user to authenticate.

## Keep documentation current

Keep unresolved defects in `docs/KNOWN-ISSUES.md`. Include a stable symbol or test path and the observed failure. Remove an entry when the defect is fixed. Do not reuse issue IDs.

Keep milestone plans, completed reviews, audit worksheets, and task progress out of permanent documentation. Git history preserves prior records. This file describes how to work in the repository, not project status.
