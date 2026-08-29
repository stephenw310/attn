# M5 Implementation Plan: Multi-Account

**Audience:** the engineers building M5. Same contract as [M3-PLAN.md](M3-PLAN.md): every task is one PR,
nothing is done until `npm run verify` is green, and "spec F18" means a section of [SPEC.md](SPEC.md)
(v0.17). Read the section before starting the task.

**Basis:** SPEC F18 (multiple accounts), D4 as revised, §9 #21 (the decision and its recorded shape),
F1 (per-account auth), F2 (per-account sync sessions), F6 (draft account binding), F12 (cross-account
notifications), §6 (architecture), §7 (the new account-switch budget).

**Goal:** move the app from "the account" to "the active account among N" without weakening any single-
account guarantee. The store has been account-keyed since M0, so this milestone is not a data-model change —
it is an ownership change in every component that currently holds one auth session, one sync session, one
executor target, or one notifier gate. The invariant that defines the milestone: **no code path may ever
read or write another account's rows than the one it was invoked for**, and every existing e2e must keep
passing with a second account signed in.

---

## Open decisions awaiting product sign-off

The spec records a default for each so work can start; flipping one later is a bounded edit to the named
task. Do not silently deviate from the default — a reversal goes through SPEC §9 first.

| # | Decision | Default in spec | Alternative | Flip cost lands in |
|---|---|---|---|---|
| D1 | Unified inbox | Out of v1: switched accounts only (F18, §2) | A merged cross-account inbox view | New milestone — not an M5 edit; reopens splits, counts, search, From identity |
| D2 | Inactive-account liveness | **Resolved 2026-08-28 (owner): confirmed** — fully live: poll 60s, drain queues, notify, snooze returns (F18) | ~~Frozen until switched to~~ | A2, A4 |
| D3 | Remove-account semantics | **Resolved 2026-08-28 (owner): remove always drops tokens; the confirmation asks Delete local data (default) or Keep** — kept rows stay dormant and re-adding the same address resumes from stored cursors (F18) | ~~Silent purge with no choice~~ | A6 |
| D4 | Composer From picker | **Resolved 2026-08-28 (owner): none** — the composer uses the active account: new mail binds to the account active at open, replies/forwards to the source thread's owner, which is the active account in every reachable flow (F6) | ~~From dropdown on new mail~~ | A5 |
| D5 | Badge & notification aggregation | All accounts notify; badge sums across accounts (F12) | Active-account-only badge/notifications | A4 |
| D6 | Milestone order | M5 after M4 in sequence, may interleave (§8) | Land M5 before M4's feature work | scheduling only |
| D7 | Snippets (F8) / AI key (F17) scope | Global, stored under `__app__` when those M4 features ship | Per-account | the M4 tasks that build them |

---

## Where the single-account assumption lives today

Read this before designing anything. The schema is *not* on this list — every table is already keyed by
`account_id` (D4), `GmailQuotaLimiter`s already live in a per-account map, undo stacks are already
per-account (`clearUndo(accountId)`), settings already split `__app__` vs. per-account
(`src/main/settings.ts`), the send-as/signature cache is per-account, and `settings:getCommandUsage`
already takes an account id. What remains:

1. **Token persistence** — `src/main/auth/tokenStore.ts` reads/writes one `tokens.bin` holding one
   `TokenSet`. There is no roster.
2. **Main-process auth flow** — `src/main/index.ts`: `signIn()` *replaces* the signed-in account,
   `authGeneration` is a single global counter, `signOut()` clears the only token set, `authStatus()`
   returns one optional `email`.
3. **Service auth/protocol** — `src/main/service/protocol.ts` `ServiceAuth` carries one config+tokens;
   `ServiceRuntime.auth` (`src/main/service/runtime.ts`) is one nullable session and
   `currentAccountId()` derives from it. The `token-update` event carries a single global generation.
4. **Sync lifecycle** — `src/main/syncController.ts` is one session: one poller, one backfill, one
   lifetime chain, one `generation`. (Its per-account guards exist only to survive the old
   sign-in-replaces-account switch.)
5. **Executors** — `ActionExecutor`, `DraftMirrorExecutor`, `OutboxSender`, and `SnoozeScheduler` all take
   a `currentAccountId` callback and drain **only** that account. A queued action for any other account
   waits forever.
6. **Notifications** — `src/main/notify.ts` `MailNotifier` holds one `accountId` gate; `pendingFocus` in
   `src/main/index.ts` has a thread id but no account; `notification-candidates` already carries
   `accountId` but only ever the current one. The notification pause is app-global (keep it).
7. **Renderer** — `status.email` is the account (`Inbox.tsx`, `MailHeader.tsx`);
   `src/renderer/src/actionReconnect.ts` exists *because* sign-in used to replace the account
   ("Connected as X — pending changes for Y remain paused") — that whole situation disappears.
8. **IPC** — the account is implicit in nearly every channel; `mail:changed`, `sync:state`,
   `outbox:changed` broadcasts are untagged, so the renderer cannot tell whose mail changed.
9. **E2e seed** — `src/main/dev/seed.ts` + `e2e/fixtures/*.json` create exactly one account
   (`fixture.account`); `TestSeams` and every `attn:test:*` handler resolve one `currentAccountId()`.

---

## Global rules (carried from M3, still binding)

1. **No runtime compatibility-migration framework.** `src/main/db/schema.ts` stays the single snapshot;
   A1 bumps `CURRENT_SCHEMA_VERSION` 21 → 22 and publishes its DDL for the manual dogfood upgrade
   (AGENTS.md). The *token file* is not SQLite: A1's one-time fold-in of legacy `tokens.bin` is
   deliberate, tiny, and self-deleting — do not generalize it into a framework either.
2. **IPC has three parts** — main handler, preload bridge, typed channel map in `src/shared/ipc.ts` — all
   in the same commit.
3. **Mail content is untrusted**, incoming and outgoing alike.
4. **Every user-facing capability registers a palette command** (F5): add/switch/remove account included.
5. **Extend the e2e suite in the same PR as the feature**, and keep real Gmail out of e2e — multi-account
   correctness gets seeded-store e2es and mock-provider unit tests.
6. **Time-driven code takes `SchedulerTime`** (`src/main/time.ts`) — per-account pollers and retry ladders
   included. No wall-clock waits in tests.

## Architecture contract for the milestone

These are the load-bearing choices from §9 #21(g)(h); every task below assumes them.

- **The utility process owns the active pointer; main owns the roster.** Main holds the ordered roster in
  the encrypted token file and relays it whole on every change; the utility persists `activeAccountId` as
  an `__app__` setting, and at initialize the persisted choice wins over main's snapshot so a crash-restart
  lands on the last switch. The renderer only ever *asks* to switch.
- **One sync session per account.** `SyncController` stays almost exactly as it is — one instance *per
  account* held by a small registry, instead of one instance reused across sign-ins. Its `generation`
  guard becomes per-account-session. Per-account cursors already exist in `sync_state`.
- **Executors iterate accounts.** Each trigger pass visits every signed-in account, active account first.
  One in-flight remote call per executor overall (same as today) — concurrency across accounts is not a
  goal; fairness and liveness are.
- **The lifetime chain (sweep → attachment flags → FTS backfill) is a single global slot.** One account
  runs it at a time; the active account preempts at the next page boundary (the pacing hooks —
  `shouldContinue`/`shouldYield` — already exist for exactly this).
- **Every read result and broadcast is tagged with its owning `account_id`.** The renderer keeps the
  active id, filters broadcasts, drops mismatched responses, and **remounts the mail tree keyed by
  account id on switch** — no per-call account threading, no stale-response bleed.
- **Priority order within the utility, across all accounts:** interactive reads/writes for the active
  account → executors (any account) → pollers (any account) → the one historical-indexing slot.

---

## Task overview

| Task | State | Blocks |
|---|---|---|
| A1 token roster + auth sessions (main) | **done**, 2026-08-28 | nothing |
| A2 utility runtime: session-per-account + executors | **mostly done**, 2026-08-28 — liveness unit tests + slot preemption remain | A4, A5 |
| A3 active-account switching: shell + switcher UI | **done**, 2026-08-28 — per-account last-view restore remains | A4, A5, A6 |
| A4 notifications, badge, focus routing | **planned** (badge sum shipped with A2) | nothing |
| A5 composer/outbox/reconnect per-account correctness | **planned** | nothing |
| A6 remove account | **planned** | nothing |
| A7 multi-account perf + isolation audit | **planned** | v1 sign-off |

A1 → A2 → A3 is a strict sequence; A4, A5, A6 are independent of each other after A3; A7 closes the
milestone.

### What the 2026-08-28 switch-account slice shipped, and where it deviated

Add account, switch account (menu / palette / `Mod+1..9`), per-account sign-out with survivor fallback,
per-account sync sessions with 60s background polling for inactive accounts, badge summed across the
roster, durable active-account persistence, multi-account seed fixtures, and the `accounts.spec.ts` +
`runtime.test.ts` coverage. Deviations from the task text above, all deliberate:

- **No schema bump.** Switcher order lives in the encrypted token file (a v2 ordered roster) beside the
  tokens it orders, so `accounts.position` and the 21 → 22 DDL were unnecessary. The schema stays at 21.
- **Executors were not rewritten to iterate accounts** — the runtime holds one executor *set per account*,
  each bound through its existing `accountId()` callback. The classes stay single-account; cross-account
  liveness holds by construction. The A2 "Done when" liveness tests (inactive-account send deadline,
  inactive snooze return, offline drain of a non-active queue) still need to be written against this shape.
- **Events are filtered, not tagged.** Renderer-facing events (`sync-state`, `mail-changed`, `outbox-*`)
  describe only the active account — the runtime drops the rest — while `token-update`,
  `actions-reverted`, `body-hydration-failed`, and `notification-candidates` carry `account_id`. The
  renderer's existing account-change reset owns the swap; no remount key was needed.
- **The indexing slot serializes without mid-run preemption.** A waiting active account is granted before
  waiting inactive ones, but a running inactive chain finishes or pauses on its own retry ladder first.
  Interactive work still preempts everything through the pacing hooks, which now also yield to other
  accounts' foreground provider work and executors. Page-boundary preemption stays open under A2.
- **`accounts:setActive` resolves through the utility** (an internal op, not a broadcast), so its response
  guarantees every later renderer read is answered for the new account — the race the tagging design
  existed to prevent.

PR #94 review hardening (2026-08-29): the mail tree now remounts keyed by account so the first post-switch
frame can never show the previous account's rows; a torn-down account's draft/outbox workers park a
*retirement* promise that gates re-creating a session for the same id (two executor sets on the same outbox
rows could double a non-idempotent Gmail draft create); re-authentication resets the account's sync session
(`onSignIn`) instead of resuming it, so the history poller drops the client built on the replaced
credentials; and account switching/adding/sign-out are blocked while any composer is open — `Esc` saves and
closes first — with an e2e proving a typed reply survives a switch attempt.

Second review round (2026-08-29): roster updates from sign-in/sign-out go through an awaited
`apply-accounts` operation — the utility answers with the active account whose sessions actually exist,
deferred re-creates included, so main can never publish an `AuthStatus` naming a still-retiring account
while reads route elsewhere; `set-active-account` likewise waits for a pending session instead of failing.
Sign-in no longer activates a newly added account at all: activation runs through the renderer's guarded
switch (reading a live composer-open ref, since the browser OAuth flow can complete minutes after the
click), which is what closes the completion-mid-compose remount hole. The indexing slot picks its next
holder at hand-over time, so an account switch made while queued still runs the newly active account's
historical chain first (focused `IndexingSlot` unit tests).

---

### A1 — Token roster and auth sessions (main process)

**Status: done, 2026-08-28** (shipped with the switch-account slice; the `accounts` table is untouched —
see the deviations note above). Spec F1, F18.

Replace the single-`TokenSet` world with an account roster, without touching the utility yet (the runtime
keeps receiving one `ServiceAuth`-shaped session per account through the existing control channel until A2
replaces it — this PR keeps today's single-active behavior end-to-end green).

- `tokenStore.ts`: an encrypted map `{ version: 2, accounts: { [normalizedEmail]: TokenSet } }` in
  `tokens.bin`. Loading a legacy single-`TokenSet` file folds it into the map under its `email` (a legacy
  set without an email is dropped with a logged warning — it was unusable anyway) and rewrites the file
  once. Use `normalizeEmailKey` (`src/shared/address.ts`) as the map key everywhere; the display string
  keeps its original casing in the `TokenSet`.
- ~~`accounts` table gains `position INTEGER NOT NULL DEFAULT 0`~~ — dropped in implementation: switcher
  order is the token-file roster order, so there is no schema change and no dogfood DDL for this milestone
  so far.
- `index.ts`: `authGeneration` becomes a per-account counter (`Map<accountId, number>`); `signIn()`
  becomes **add-or-refresh** — an existing normalized address updates its tokens in place, a new one
  appends at the end of the order; nothing signs out. Token-update events from the utility carry
  `accountId` + that account's generation, and the stale-update guard (`tokenUpdate.ts`) checks per
  account.
- Shared auth contract: `AuthStatus` becomes
  `{ configured, accounts: Array<{ id, email, position, state: 'ok' | 'reconnect' }>, activeAccountId }`
  (`signedIn` derives from `accounts.length > 0`; keep a helper so call sites read clearly). New invoke
  channels: `accounts:setActive`, `accounts:reorder`, `accounts:remove` (stub returning
  not-implemented until A6). `auth:signIn` keeps its name — it is now "add account".
- Preload + renderer compile against the new shape with minimal behavior change: the login screen treats
  zero accounts as signed out; `MailHeader` shows the active account. The switcher UI itself is A3.

**Done when:** unit tests cover the map store, the legacy fold-in (including the rewrite-once and the
no-email drop), add-vs-refresh sign-in, per-account generation guarding, and roster ordering; the full
existing e2e suite passes with the reshaped `AuthStatus`.

### A2 — Utility runtime: one sync session per account, executors drain all accounts

**Status: mostly done, 2026-08-28** — shipped as per-account executor sets (deviations note above). Still
open from "Done when": the mock-provider liveness tests (a queued send on the *inactive* account leaving
on deadline, a snooze return firing on the inactive account, an offline queue on a non-active account
draining after relaunch, add-account leaving the first account's cursors byte-identical) and indexing-slot
preemption at a page boundary. Spec F2, F18, §9 #21(b)(g).

- Protocol: the `auth` control message becomes `accounts` — the full roster (config + token sets +
  per-account generations) plus `activeAccountId`. `sign-out` becomes per-account removal-from-roster
  (data purge is A6; here it only stops the session).
- `ServiceRuntime`: replace `auth: ServiceAuth | null` with an `AccountRegistry` — per account: auth,
  generation, one `SyncController`, one quota limiter (map exists). Controllers are created when an
  account joins the roster and torn down (via their existing `stop()`/generation discipline) when it
  leaves. `currentAccountId()` survives only as `activeAccountId()` for interactive handlers.
- Poller cadence: the active account keeps 15s foreground / 60s background; inactive accounts poll at 60s
  regardless of window focus. Window focus continues to flow through the `focus` control.
- **The historical-indexing slot:** extract the lifetime → attachment-flags → FTS chain trigger out of
  each controller's "backfill done" continuation into a runtime-level scheduler holding one slot. Queue
  order: active account first, then roster order. The active account's chain preempts a running inactive
  one at the next `shouldContinue` check; the preempted cursor resumes later (cursors are durable — that
  property is what makes preemption free). The four-cursor contract from M3-PLAN §"Where sync stands
  today" still binds, per account.
- **Executors iterate accounts:** `ActionExecutor`, `DraftMirrorExecutor`, `OutboxSender`,
  `SnoozeScheduler` take the roster (active first) instead of a single `currentAccountId`. Every drain
  pass visits each account's queue to exhaustion before the next account; a permanent failure in one
  account's queue must not stop another account's drain. `DraftMirrorExecutor.stop()`'s five-second
  quiesce covers whichever account's checkpoint is in flight (there is at most one — single in-flight
  rule). `SnoozeScheduler` arms one timer for the earliest due reminder **across accounts** and wakes the
  owning account's return path.
- Badge: `countNotificationEnabledUnread` summed across the roster.
- Seed format: `dev/seed.ts` accepts either the current single `account` fixture or
  `accounts: [{ account, labels, threads, … }]`; `loadSeed` returns the roster. Existing fixtures stay
  valid unchanged. Test seams that resolve `currentAccountId()` gain an optional explicit account
  argument, defaulting to active.

**Done when:** mock-provider unit tests prove — two accounts polling independently; an offline queue on
account A draining after relaunch while B stays untouched; a queued send on the *inactive* account leaving
on deadline (fake timers); a snooze return firing on the inactive account; the indexing slot yielding to
the active account and resuming the preempted cursor; add-account leaving the first account's cursors
byte-identical. The e2e suite passes with a two-account seed booting (UI still shows the active account
only).

### A3 — Active-account switching: IPC tagging, renderer shell, switcher UI

**Status: done, 2026-08-28** — with events filtered active-only instead of tagged (deviations note above).
Still open: per-account last-view/selection restore on switch (a switch currently keeps the view kind and
resets selection), the per-account one-line sync status in the account menu, the reconnect mark (A5 owns
its state), and the §7 100ms switch measurement (A7's perf job). Spec F18, F3, F5, F15, §7, §9 #21(h).

- Tag every mail-facing read result and broadcast with `accountId` (`mail:changed`, `sync:state`,
  `outbox:changed`/`outbox:progress`, list/conversation/draft/outbox/search results). The renderer holds
  `activeAccountId` from `AuthStatus`, ignores broadcasts for other accounts (except roster-level
  surfaces: account menu badges, aggregate badge), and discards tagged responses that no longer match.
- `accounts:setActive`: utility flips the pointer, persists it, reprioritizes (poller cadence, executor
  order, indexing slot), and acks with the new id; the renderer then **remounts the mail tree keyed by
  account id**. Per-account last view/selection/scroll live in renderer session memory and restore on
  return (same discipline as per-mailbox restore in T22). Sidebar collapse state stays global.
- Switcher surfaces, all registered as palette commands (F5): `Mod+1..9` by `accounts.position`; account
  menu listing accounts with the active check, per-account unread count, and reconnect mark; *Switch to
  <address>*; *Add account…*. Settings gains reorder (drives `accounts:reorder`).
- Sync footer shows the active account's state (unchanged component, tagged feed); the account menu shows
  a one-line per-account status (Live/Syncing/Offline/Error/Reconnect) so background failures are
  discoverable without switching.
- `actionReconnect.ts`'s "pending changes for X remain paused" message and its e2e retire — sign-in no
  longer replaces the account. Per-account reconnect UI is A5's scope; this task keeps the auth-paused
  banner keyed to the active account.

**Done when:** e2e (two-account seed): switch via chip menu, palette, and `Mod+2`; warm-switch renders the
other account's cached list under the §7 100ms budget (measured in A7's perf job, asserted functionally
here); selection/scroll restore per account; zero cross-account rows/labels/counts/chips after switch
(explicit isolation assertions on list, sidebar, contacts autocomplete, and search); relaunch restores the
persisted active account; new visual artifacts (e.g. `account-menu.png`, listed in AGENTS.md) inspected.

### A4 — Notifications, badge, and focus routing across accounts

**Status: planned.** Spec F12, F18, §9 #21(e).

- `MailNotifier` drops its single-account gate: candidates already carry `accountId`; planned
  notifications name the owning account whenever the roster has more than one entry (title suffix, both
  per-message and summary forms — extend `shared/notifications.ts` planning and its tests).
- `pendingFocus` gains `accountId`; clicking a notification for an inactive account performs
  `accounts:setActive` first, then the existing focus flow; summary clicks land on that account's inbox.
  The 60s TTL and retention rules are unchanged.
- Badge = A2's roster sum (already emitted); Windows tooltip counts follow.
- Batching stays per account per poll cycle: seven new conversations on A and two on B in the same minute
  produce one summary for A and two detail toasts for B, not one merged summary.

**Done when:** unit tests cover per-account batching, title account-naming (only when >1 account), and
focus planning with a switch; e2e covers a notification-driven switch+focus through the seeded store and
badge sum across two seeded accounts.

### A5 — Composer, outbox, and reconnect per-account correctness

**Status: planned.** Spec F6, F18, §9 #21(c).

- Draft account binding: `draft:createReply` and outbox rows already carry `account_id` — make the binding
  explicit and asserted: new drafts bind to the account active at open; reply/forward drafts bind to the
  source thread's account even if the active account changed between reader open and `R`. The composer From
  field renders the draft's owning account (not the active account) and each account's own cached primary
  send-as signature/display name applies.
- Views: Drafts and Outbox list the active account's rows only. The undo-send toast belongs to the
  sending account's context; switching accounts mid-window hides the toast but **never** cancels the
  durable deadline (A2 proved the send; this task proves the UI). Reopening from Outbox on the owning
  account restores the composer.
- Per-account reconnect: an auth-failed account pauses its own executors (per-account `resumeAuthFailures`
  in place of the current global op); the auth-paused banner shows when that account is active; the account
  menu's reconnect mark (A3) is driven by the same state; a successful re-auth resumes exactly that
  account. `attn:test:failNextActionAuth` gains the account argument from A2's seam work.
- Shutdown: `DraftMirrorExecutor.stop()`'s quiesce contract holds regardless of which account owns the
  in-flight checkpoint (regression test, not new behavior).

**Done when:** e2e proves — reply drafted on account A stays A's after switching to B (From, mirror,
Drafts membership); an undo-send on A completes while B is active and Z on B does not touch it; auth-pause
on A shows the banner only when A is active while B keeps triaging, and reconnect resumes A's queue
(seeded-store auth seam). Unit tests cover the reply-binding race and per-account resume.

### A6 — Remove account

**Status: planned.** Spec F18, F15, §9 #21(d).

- `accounts:remove` (explicit confirmation in the UI; palette command *Remove account…*): the confirmation
  always removes the token-map entry and stops the account's session and executors, and asks what to do
  with local data — **Delete local data** (default) or **Keep local data** (D3). Delete runs in one
  transaction: the account's rows from **every** account-keyed table (enumerate from the schema, not a
  hand-list that rots — walk `CURRENT_SCHEMA` tables for `account_id` columns in a unit-tested helper),
  its FTS rows (`removeAccountFromIndex` exists), then its outbox/attachment spool files. Keep leaves the
  rows dormant — no roster entry, so nothing lists or reads them — and re-adding the same normalized
  address resumes from the stored cursors instead of re-backfilling (the F1 add-or-refresh path plus the
  existing cursor plan already produce this; the e2e proves it). `__app__` settings survive either way.
- Active fallback: removing the active account activates the next by position; removing the last account
  lands on F1's signed-out screen (and clears `activeAccountId`).
- The legacy single-account "Sign out" menu item becomes *Remove account* for the active account —
  same semantics, one code path. (Today's sign-out already abandoned local rows only by accident of the
  next sign-in overwriting them; purge-on-remove is the deliberate replacement.)

**Done when:** unit test walks the schema and asserts the purge helper covers every `account_id` table
(this is the guard that keeps future tables from leaking); e2e removes a seeded account with Delete and
proves zero rows/FTS/spool via a test seam, survivor account intact, relaunch durability, and last-account
fallback to the signed-out screen; a second e2e removes with Keep, proves the rows survive but nothing
lists them, and re-adds the account to prove sync resumes from cursors without a fresh backfill.

### A7 — Multi-account performance and isolation audit

**Status: planned.** Spec §7, F18 acceptance criteria.

- Perf job variant: two seeded profiles (10k + 1k threads) measuring warm account switch p95 against the
  100ms budget, steady-state memory against the 500MB ceiling with both accounts live, and list/triage
  budgets unchanged with the second account polling. Record results in T20-EVIDENCE.md style.
- Isolation audit as executable tests, not review: a sweep-style unit test that runs every read query in
  `db/queries.ts` and `db/search.ts` against a two-account store and asserts no result row belongs to the
  other account; an e2e pass asserting search, autocomplete, label picker, move picker, splits, snoozed,
  drafts, and outbox all stay scoped after multiple switches.
- Close out: real-Gmail dogfood observation with two real accounts (add second account mid-lifetime-sweep;
  observe slot preemption, notification routing, badge sum) recorded here, mirroring M2's dogfood-run
  format.

**Done when:** the perf job runs in CI on PRs, budgets hold, the isolation sweeps are green, and the
dogfood observations are recorded in this file.
