# M4 Implementation Plan: Power Finish

**Audience:** the engineers building M4. Same contract as [M1-PLAN.md](M1-PLAN.md), [M2-PLAN.md](M2-PLAN.md),
and [M3-PLAN.md](M3-PLAN.md). Every task is one PR. Nothing is done until `npm run verify` is green. "Spec F8"
means a section of [SPEC.md](SPEC.md) (v0.18). Read the section before starting the task.

**Basis:** SPEC §8 M4, F6 (Attn signature footer), F8 (snippets), F9 (follow-up reminders), F12 (badge polish),
F15 (settings), F17 (AI reply drafting and inline autocomplete), §6 Packaging (auto-update, signing, notarization), §9 #5
(remote images), and the deferrals the earlier plans parked here: the settings surface (M1-PLAN T9/T8 notes), the remote-image block
toggle (M1-PLAN, T11 notes), the Windows unread badge overlay (M1-PLAN accepted deviations), and the
`Mod+/` cheat sheet (the two "lands at M4" stubs in `MailHeader.tsx`). The 2026-08-30 refresh against
`main` at `15e13b4` also carries PR #98's historical sync limit into T32A and incorporates the account
management shipped in PRs #96 and #99.

**Goal:** M4 turns a daily-drivable triage client into a finished v1. Snippets, follow-up reminders, an
optional Attn signature footer, AI reply drafting, and inline autocomplete land. Every deferred toggle
gets its settings home, and the packaged app
learns to update itself with real signatures. M4 is the last milestone before the v1 tag, so it ends with a
sign-off task that rolls up every outstanding manual check.

## Task list

Every row below carries the same state its task section carries. The whole milestone is merged on `main`
(#101, with the Windows badge revision in #104); what is left is T39's operator half and T40's manual
evidence.

| Task | State | Blocks |
|---|---|---|
| T32 settings surface and cheat sheet (F15) | **shipped** 2026-08-31 (`2eda759`) | nothing |
| T32A per-account historical sync limit (F2, F15) | **shipped** 2026-08-31 (`64f8e87`) | nothing |
| T32B optional "Sent with Attn" signature footer (F6, F15) | **shipped** 2026-08-31 (`80a9cad`) | nothing |
| T33 remote-image control (§9 #5) | **shipped** 2026-08-31 (`df70c80`) | nothing |
| T34 snippets (F8) | **shipped** 2026-08-31 (`e4d428e`) | nothing |
| T35 follow-up reminders (F9) | **shipped** 2026-08-31 (`cbb899e`) | nothing |
| T36 AI writing foundation (F17) | **shipped** 2026-08-31 (`b87a3ec`) | nothing |
| T37 AI reply drafting in the composer (F17) | **shipped** 2026-08-31 (`12be729`) | nothing |
| T37A inline AI autocomplete (F17) | **shipped** 2026-08-31 (`2a50fda`) | nothing |
| T38 Windows unread badge overlay (F12) | **shipped** 2026-08-31 (`1ed0d80`); revised after Windows dogfood 2026-09-01 (`583f273`) | nothing |
| T39 auto-update, signing, notarization (§6) | **code shipped** 2026-08-31 (`8ace1ab`); release workflow + About surface 2026-09-04; operator credentials and the release-feed decision open | T40's update-in-place check |
| T40 M4 exit and v1 sign-off | **in progress** — see [T40-EVIDENCE.md](T40-EVIDENCE.md) | the v1 tag |

**Why this order.** T32 goes first because T32A's sync control, T32B's footer preference, T33's toggle,
T34's manager, and T36's enable screen need it. T32A is separate because changing a running account's sync limit needs its own lifecycle
and persistence tests. T32B covers footer insertion and draft durability before T37 integrates AI writing
with the signature. F17 has three tasks: shared provider and consent controls, explicit reply drafting,
then autocomplete with its separate opt-in and typing lifecycle. T37A follows T37 so their cancellation
and keyboard handling can be tested together. The suffix preserves the existing T38–T40 task references,
following M2's T14A through T14E precedent. T39 is independent of everything else but
has operator lead time (certificates, notary credentials), so start its prerequisites in week one even if
the code lands late.

**What M4 does not absorb.** M5's multi-account implementation and engineering audit have shipped;
[M5-PLAN.md](M5-PLAN.md) still requires the real-Gmail two-account dogfood observation. T32 reuses that
implementation and supplies the settings-only account reorder work that remains absent from code.
F18's scoping rules bind every new preference. The KNOWN-ISSUES gaps stay in KNOWN-ISSUES, with one
exception: GAP-1's wanted assertions ride T35, because it changes the poller path that GAP-1 describes.
The merge verification also reproduced an intermittent M5 notification-focus failure; T32 owns the
follow-up below, and T40 requires its resolution before sign-off.

---

## Global rules (carried from M3, still binding)

1. **Every schema change has a runtime migration.** `src/main/db/schema.ts` is the new-profile snapshot.
   Every edit bumps `CURRENT_SCHEMA_VERSION` and appends one immutable, contiguous step to
   `src/main/db/migrations.ts`. The retained path starts at schema 21 and includes the historical changes
   recorded below.
2. **IPC has three parts:** main handler, preload bridge, and the typed channel map in `src/shared/`. All in
   the same commit.
3. **Mail content is untrusted**, incoming and outgoing alike. In M4 this extends to LLM output: an AI draft
   enters the composer through the same sanitize path as pasted content. Autocomplete previews render as
   text only, and acceptance inserts plain text without interpreting markup.
4. **Select on `data-testid`** in e2e.
5. **Every user-facing action is a registered command** (F5). The palette inventory test asserts this, so a
   new settings control without a command is a red test, not a review comment.
6. **One reducer, two sources.** Nothing in M4 may add a second write path for mail state. Follow-up
   resurfacing (T35) goes through the same reducer as snooze return. Maintain PR #98's derived
   `thread_mailboxes` rows in the same transaction via `refreshThreadMailboxes`; cached counts and
   keyset-paged lists must agree after a return, undo, or authoritative snapshot.
7. **Interactive work outranks background work.** AI streaming (T37), autocomplete (T37A), and update
   downloads (T39) must not delay typing, saves, sends, action replay, or polling.
8. **Time is injectable.** Every new timer takes `SchedulerTime` from `src/main/time.ts`. T35's follow-up
   deadlines, T37A's debounce/rate limits/timeouts, and T39's update-check interval qualify. The renderer
   autocomplete controller takes an equivalent injectable clock; no test waits on wall-clock time.
9. **New state declares its account scope** (F18, in v1 since §9 #21). Per-account state carries the owning
   `account_id`; app-global state uses the settings sentinel (`APP_SETTINGS_ACCOUNT_ID`). F18 already
   decides for M4's features: snippets, the F17 provider key, model, voice profile and enable toggles, the
   undo-send delay, auto-advance, and remote-image preferences are app-global; reminders, drafts, and
   outbox rows, T32A's `lifetimeThreadCap`, and T32B's `attnSignatureEnabled` are per-account. Account
   ordering belongs to main's encrypted token roster, not a new SQLite column or duplicate settings list.
10. **If your task changes the verify pipeline, harness behavior, or the screenshot-artifact list, update
    AGENTS.md in the same PR.**

---

## T32: settings surface and keyboard cheat sheet

**Status: shipped (2026-08-31, `2eda759`; review follow-ups in `1e3d082`).** Real-OS login/menu-bar evidence stays in T40.

**Depends on:** nothing · **Unblocks:** T32A, T32B, T33, T34, T36 · **Spec:** F15, F16, F18, D6, §5

### Why

Every settings-shaped decision since M1 has been deferred to "the M4 settings surface", and the account
menu ships two dead items whose tooltips literally say so (`MailHeader.tsx`, the `Settings` and
`Cheat sheet` entries). The undo-send delay has been configurable in the database since M2
(`outbox/queue.ts` reads `undoSendDelaySeconds`) with no way to set it. Auto-advance direction is
hardcoded. Account reorder has neither a bridge nor a control despite M5's planned `accounts:reorder`.
Notification pause works through the Windows tray but has no settings or palette access. This task gives
those controls a home and connects them to the existing account and notification behavior.

### Design (decided)

- **A full-window settings view**, not a dialog. It replaces the content region the way the new-message
  composer does: the prior list or reader stays mounted and hidden, and `Esc` or Back restores it exactly.
  The sidebar stays visible. Open it with `Mod+,`, the account-menu item, or the palette command
  `Open settings`.
- **Sections at ship time:** Accounts (live roster, status, add, reconnect, Sign out, and `Mod+1..9` reorder),
  Triage (undo-send delay; auto-advance next, previous, or back to list), Notifications (global pause and
  resume), Background (launch at login; macOS menu-bar icon, default off),
  and Appearance (the four F14 themes). T32A adds Sync & storage and T32B adds Compose for the active
  account. T33, T34, and T36 add their own sections. Label account-specific settings with the owning email and distinguish them
  from app-wide preferences.
- **Reuse shipped account behavior.** Use the same guarded add, switch, reconnect, and Sign out flows as
  the account menu. Sign out retains Delete/Keep local data, removal-in-progress guards, survivor order,
  and the persistent deletion-failure warning from #99. Account status comes from `accounts:getStatuses`
  plus `accounts:statusChanged`; late snapshots cannot replace newer pushes or another account's data.
- **Account reorder is implementation work, not just wiring.** Add the planned typed `accounts:reorder`
  command in main, preload, and shared IPC. Accept an exact permutation of the current signed-in roster,
  reject duplicates, missing or unknown ids, and reject a stale request if the roster changed. Main
  persists the order through `auth/tokenFile.ts` and `auth/tokenStore.ts`, then publishes the authoritative
  roster to the utility and renderer without restarting account sessions or changing the active account.
  Keep the latest tokens when a refresh races the reorder. Menu order, digit shortcuts, and sign-out
  successor selection use that same order. Use accessible move-up/down controls and a palette entry.
- **Notification pause:** expose the existing one-hour, until-tomorrow, and resume actions on both OSes,
  with the paused-until time visible. Reuse `notificationsPausedUntil`, `notificationQueries.ts`, and the
  existing deadline helpers; the pause spans every account while split `notify` flags remain per-account.
  The Inbox split-strip gear opens `SplitRuleManager.tsx` for those flags; Settings does not duplicate it.
  Do not add separate per-account pause state or a second notification scheduler.
- **Pending notification delivery must survive composer close and account switch.** Resolve the
  intermittent failure recorded below while integrating account and notification settings. Preserve a
  target until the correct live account view accepts it; a subscription cleanup or saved-view restore
  must not silently lose the click. Retain the existing TTL and composer guards.
- **Storage and defaults:** SQLite preferences use `src/main/settings.ts` inside the utility process.
  T32's app-wide keys use `APP_SETTINGS_ACCOUNT_ID`; the new keys are `autoAdvanceDirection` and
  `menuBarIcon`. Reuse `undoSendDelaySeconds`, `launchAtLogin`, and `notificationsPausedUntil`. Read the
  undo-send choices and default from `src/shared/outboxTuning.ts`, not a second literal list. Keep account
  reorder in the token roster and T32A's cap under its account id. Settings do not expose every constant
  collected by PR #98: poll intervals, quota reserves, page sizes, search candidate limits, save deadlines,
  retries, and renderer timings remain development defaults in their existing tuning modules.
- **Every control is also a palette command** (rule 5): `Set undo send delay…`, `Set auto-advance…`, and so
  on. The theme commands from T30 already exist; the settings pane reuses them.
- **The cheat sheet (`Mod+/`)** is a dismissable overlay listing the §5 keyboard map. It renders from the
  command registry, not from a hardcoded table, so a new command with a shortcut appears without editing the
  sheet. It groups by the registry's existing categories. `Esc` closes it. Both dead account-menu items are
  replaced by the real entries in this PR.

### Implementation guide

- Add typed `settings:get`/`settings:set` requests with a key allowlist that declares each key's value
  type and account scope. Keep SQLite work in utility handlers; main applies OS effects through explicit
  typed operations. Reuse existing theme, split, and account APIs. Never expose arbitrary setting names,
  OAuth credentials, or a writable account id through a generic settings handler.
- Auto-advance direction is consumed where triage advance already happens in `Inbox.tsx`; the setting
  changes the target row selection, nothing else.
- The menu-bar toggle only installs or removes the macOS `Tray`. Windows tray behavior is unchanged (F16
  says the Windows tray is always present).
- Changing launch at login must explicitly update the OS registration despite the existing
  `loginItemRegistered` startup guard. Ordinary launches still respect an OS-side disable; test and
  development runs never register real login items. Reuse the existing Windows hidden-launch arguments.
- Settings must not introduce an account-switch path around the composer/removal guards. Account-scoped
  reads and writes bind to the account at dispatch; late completions cannot overwrite a newly selected
  account's controls. Back restores the correct account's paginated selection and scroll position.

### Testing

- E2e: open settings by `Mod+,`, by account menu, and by palette. Change the undo-send delay, send a seeded
  message, and assert the countdown uses the new window. Change auto-advance to previous and assert the
  triage advance direction. Relaunch with `boot.relaunch()` and assert both persist.
- Unit and e2e: reorder three seeded accounts, relaunch, and assert menu order, `Mod+1..9`, stable active
  account, and sign-out successor order. Reject malformed/stale permutations and preserve concurrent
  token refreshes; a failed persist leaves the old order intact. Exercise Sign out's Delete/Keep and
  failure-warning behavior from settings, plus a delayed account-status response superseded by a push.
- Unit and e2e: pause all accounts, suppress notifications for inactive accounts too, resume, and retain
  each account's split flags. Exercise settings/palette without a tray icon and persist the deadline
  across relaunch. Verify background settings with fake OS adapters; reserve real login-item checks for T40.
- E2e: `Mod+/` opens the cheat sheet, shows the `G` chords, and `Esc` closes it. A registered command with
  a shortcut added by the test seam appears on the sheet.
- New screenshot artifacts `settings.png` and `cheat-sheet.png`, added to the AGENTS.md list in this PR.

### Notification-focus follow-up from merge verification

Verified on macOS against runtime/test code identical to `main` at `15e13b4`, 2026-08-30. The test
`an open composer holds a notification switch until the draft closes` in `e2e/accounts.spec.ts:562`
failed in the full suite and once in five focused repeats. The account switches to `second@attn.test`,
but the reader never opens `Beta launch checklist`; the final view is that account's inbox list.

Reproduce with `npm run e2e -- --grep 'an open composer holds a notification switch' --repeat-each=5`.
Inspect `takePendingFocusTarget` in `src/main/index.ts`, `mail.onFocusThread` in `src/preload/index.ts`,
and the focus/restore effects in `Inbox.tsx`. The exact race still needs isolation; consumption before
delivery during a subscription change is one path to test. Add a deterministic regression that holds
the relevant asynchronous response across composer close and account remount. A retry or longer timeout
does not resolve the defect. This plan PR does not change runtime behavior or weaken the failing test.

### Done when

The two "lands at M4" stubs are gone, every listed setting persists across relaunch, the palette inventory
covers the new commands, the notification-focus regression is resolved, and the cheat sheet needs no
source edit to stay current.

---

## T32A: per-account historical sync limit

**Status: shipped (2026-08-31, `64f8e87`; review follow-ups in `1e3d082`).** Real-Gmail cap observations stay in T40.

**Depends on:** T32 · **Unblocks:** nothing · **Spec:** F2, F10, F15, F18, §9 #22

### Why

PR #98 bounds lifetime indexing with `LIFETIME_THREAD_CAP`, currently 400,000 conversations, and preserves
a capped cursor for later expansion. The limit is still compile-time; `runLifetimeSweep` accepts an
injected `threadCap`, but the production controller does not read a preference. F15 needs a control that
applies without rebuilding or signing out, independently for work and personal accounts.

### Design (decided)

- Add **Historical sync limit** under **Sync & storage**, labeled with the active account's email. Offer
  the default from `LIFETIME_THREAD_CAP`, a custom positive safe integer, and **All mail**, encoded as
  `LIFETIME_THREAD_CAP_UNLIMITED` (`0`). Reject negatives, fractions, invalid strings, and unsafe integers
  in both the UI and utility handler. Reset to default removes the override. Explain that All mail can
  require substantial disk space, quota, and app-open time; confirm that choice before applying it.
- Persist `lifetimeThreadCap` with `readAccountSetting`/`writeAccountSetting`; an absent value falls back
  to the compile-time default. Delete-local-data removes it; Keep-local-data retains it for re-add. This
  uses the current settings table and needs no schema bump. The generic settings allowlist owns scope
  validation, and a palette command opens the same control and confirmation.
- Describe the limit accurately: it bounds additional historical header fetching, not all local rows or
  disk usage. Inbox/recent sync, new mail, explicit server search, and on-demand reads can add more rows.
  Lowering it deletes nothing and does not evict bodies, drafts, or attachments. Body windows and local
  search result/candidate limits remain unchanged; Gmail search remains available for the uncached tail.
- Read the saved value for every production lifetime run, including restart, reauthentication, retry,
  and account-slot handover. Applying a change schedules only that account's historical work; it does not
  reset auth, restart pollers or send executors, or call the whole-session `resetSession()` shortcut.
  Settle the old historical chain before starting its replacement and release the shared indexing slot
  exactly once. Preserve M5's active-account priority and preemption; an inactive account must not start
  a second concurrent chain. Offline or paused-auth accounts save the preference and apply it on resume.
- Keep all cap enforcement in the existing lifetime-sweep option; do not apply it to Gmail's page sizes
  or raise `SEARCH_RECENT_MESSAGE_LIMIT` with it. New timing constants use the existing tuning modules
  and injected clocks rather than literals in settings components.
- Raising or disabling a reached limit resumes `capped:lifetime[:page-token]` with its saved page-start
  count. An unchanged or lower reached limit makes no further lifetime Gmail requests. A truly exhausted
  `done` cursor stays done. Mid-run changes take effect at the next safe cancellation point and reject
  late writes from the old run. Preserve history, mailbox, FTS, and split-metadata cursors.
- Expanding historical coverage must also repair derived attachment flags. `attachment_cursor='done'`
  currently means a one-time pass over already-stored threads; it cannot cover headers imported later.
  Invalidate the old run's write generation, then persist the preference and attachment-pass invalidation
  in one local transaction. Wait for the old chain to settle before starting its replacement, and run
  the existing ids-only attachment pass after the expanded walk stops. A crash must not leave newly
  imported mail permanently unflagged, and saving a preference must not wait for a network response. Do not
  reset unrelated cursors or rebuild mailbox/FTS indexes that `persistThread` already maintains.
- Refresh search coverage and the footer when the preference takes effect. Keep capped distinct from
  still syncing or complete. ETA targets the smaller of the limit and account total, while the displayed
  account total remains the coverage denominator. Do not label capped coverage as fully indexed.

### Testing

- Unit: validation, default/reset, per-account isolation, Delete/Keep behavior, and production-controller
  option wiring. Cover increase, decrease, unlimited, unchanged, and `done`, with a request held across
  the change; no stale write, duplicate chain, leaked slot, or unrelated cursor reset is allowed.
- Unit with a two-account runtime: changing A's limit while B owns the slot preserves fairness, B's
  settings, sends, and polling. Reauthenticate or restart the utility and resume the saved A cursor.
  Start with a completed attachment pass, expand into older mail with attachments, crash/relaunch, and
  prove both the attachment chip and `has:attachment` search become correct without fetching bodies.
- E2e: use the settings control through the real bridge, not just the existing test seam's `threadCap`
  override. With a scripted provider, hit a small cap, raise it, and select All mail across relaunches.
  Assert preserved page token/count, no requests on an unchanged or lower reached limit, no deleted
  rows, correct coverage/ETA, and another account's unchanged preference. No real Gmail access.
- Inspect `settings-sync.png` and add it to AGENTS.md when implemented. Re-run the standard two-account
  performance profile and `npm run e2e:perf:scale` so the new control cannot remove bounded-read behavior.

### Done when

A user can change an account's historical limit without a rebuild or sign-out. Sync resumes durably,
coverage is accurate, existing local data remains intact, and other accounts keep working.

---

## T32B: optional "Sent with Attn" signature footer

**Status: shipped (2026-08-31, `80a9cad`; Gmail signature-font interplay merged in `9aa2d61`).**

**Depends on:** T32 · **Unblocks:** T37 · **Spec:** F6, F15, F18

### Why

Users can add a short Attn attribution to outgoing mail without editing their Gmail signature. It must
be visible and removable in the composer, and preserve the existing draft lifecycle.

### Design (decided)

- Add **Include "Sent with Attn"** under **Compose**, labeled with the active account's email. Default
  on. Show the exact line and explain that the preference affects new drafts only. Add matching palette
  enable/disable commands, with no new shortcut. Persist the boolean as `attnSignatureEnabled` through
  T32's typed, account-scoped settings allowlist and `readAccountSetting`/`writeAccountSetting`.
  An absent value means on. Delete-local-data removes it; Keep-local-data retains it. No schema bump.
- Insert the plain `Sent with Attn` line when creating a local new-message, reply, reply-all, or forward
  draft. Place it after the cached Gmail signature, or after the writing area if none exists, and before
  the quote. Keep the caret in the writing area. The footer is an editable signature paragraph with
  readable secondary styling in all four themes, no hyperlink, remote image, tracking, or network lookup.
- Keep the Gmail signature's content intact and never write branding back to Gmail settings. If that
  signature already contains the same standalone line, reuse it without adding another. Do not inspect
  quoted history for this deduplication or remove any quoted attribution.
- Apply defaults only at local draft creation. Do not append a footer while reopening, importing,
  autosaving, mirroring, sending, retrying, or undoing a send. Setting changes leave open, saved, and queued
  drafts unchanged. A footer already present in a Gmail draft remains ordinary editable content. Its
  removal must survive Gmail normalization and must never cause automatic reinsertion.
- Treat the applied Gmail signature and footer as one initial signature baseline for untouched-draft
  detection. A draft with only planned fields and these defaults is discarded on close and skipped by
  the mirror. Compare against that draft's stored baseline, not current settings or the signature cache.
  Changes the user makes to the footer follow the normal edit and undo rules.
- Once the draft has user content, persist the footer in its normal body. Autosave, Gmail checkpoints,
  both MIME alternatives, queued-message previews, undo send, and crash recovery use that saved content.
  The sender must never append branding based on the account's current preference.
- T37 generation/refine inserts above the signature without replacing or duplicating either signature
  content or the footer; undoing AI insertion preserves them. T37A excludes both from autocomplete
  context and suppresses suggestions inside them. Neither AI path restores a deleted footer.

### Implementation guide

Extend `prepareDraftWithCachedPrimarySignature` in `src/main/outbox/sendAs.ts` and its local-creation
callers in `src/main/service/handlers.ts`. Compose the optional footer with the cached signature without
mutating the cache. Reuse the existing `default_signature_fingerprint` storage and signature envelope;
extend `hasOnlyDefaultPrimarySignature` as needed for footer-only defaults. Existing signature-only
fingerprints must still work unchanged. Do not reclassify imported or already-authored drafts as untouched.

Keep the footer on the editable path through `GmailSignatureNode`, composer sanitization, import, and
serialization. Do not add a send-time body rewrite or weaken the zero-formatting-loss contract. Bind
settings reads to the draft's owning account, including delayed responses during an account switch.

### Testing

- Unit: default on and per-account opt-out; each composer kind with and without a Gmail signature; exact-line deduplication;
  placement before quotes; HTML/plain-text parity; and unchanged cached Gmail signature. Cover footer
  edits and deletion through serialization and Gmail import without reinsertion or formatting loss.
- Unit with the real temporary SQLite store: footer-only and signature-plus-footer drafts are untouched,
  including planned replies/forwards. They are not mirrored or retained on close. Change the account's
  preference and cached signature after creation and prove the stored baseline still governs. Preserve
  old signature-only drafts and imported drafts. Extend account-isolation and Delete/Keep coverage.
- E2e against the seeded provider: enable for one account and leave another off; relaunch and exercise
  settings and palette commands. Inspect footer placement in all composer kinds. Save, reopen, mirror,
  import the echoed draft, queue, undo send, and send again; captured HTML and plain text each contain
  exactly the visible footer. Repeat after editing/removing it and after changing the preference with a
  saved or queued draft present. No real Gmail calls.
- T37 and T37A add their footer-preservation and context-exclusion regressions when those tasks land.
- Inspect `composer-attn-signature.png` and `composer-attn-signature-light.png`, including a Gmail
  signature and collapsed quote, and the affected settings artifact. Check all four themes and keyboard
  editing. Add the new artifacts to AGENTS.md when implemented.

### Done when

F6's footer acceptance criteria pass through the real composer and outbox. Each account controls its own
default, and the saved draft determines exactly what the recipient receives.

---

## T33: remote-image control

**Status: shipped (2026-08-31, `df70c80`; review follow-ups incl. the CSP-layer e2e in `1e3d082`).**

**Depends on:** T32 · **Unblocks:** nothing · **Spec:** §6 Security, §9 #5

### Why

Decision #5 shipped "default load" with a promise: a global "block remote images" toggle plus per-sender
overrides. M1 deferred the toggle to the settings surface. Remote images are the one place mail reading
leaks the user's IP and read-time to a sender, so v1 should not ship without the off switch.

### Design (decided)

- **Enforcement lives in the main process**, in the same request layer that already strips the
  `Cross-Origin-Resource-Policy` header for mail-frame images (§6). When blocking is on and the sender has
  no override, image requests originating from the mail frame are cancelled. The renderer cannot be the
  enforcement point; it is sandboxed and untrusted mail markup runs inside it.
- **The filter must know the sender behind each request.** The request URL names the image host and every
  mail iframe's origin is the same `about:srcdoc`, so neither identifies the message. The reader registers
  each mounted message frame with the main process keyed by message id, and the main process resolves that
  id to the sender address from the local store. Nothing in the markup or the request itself is trusted for
  this decision. Two messages from different senders can reference the same image URL and get different
  answers.
- **Blocked rendering degrades quietly.** Cancelled images leave placeholders; layout must not collapse.
  The message card shows a one-line banner: `Remote images blocked · Load once · Always load from this
  sender`. `Load once` re-renders that message with loading permitted for that render only. `Always load`
  writes a per-sender override.
- **Storage:** the global toggle and per-sender overrides are `settings` rows (`remoteImages` and
  `remoteImages:allow:<address>`), app-global under the settings sentinel (rule 9): a privacy preference
  about a sender does not change per mailbox. The default stays load (decision #5 stands).
- The settings section lists current sender overrides and can remove them. Toggle and removal are palette
  commands.

### Testing

- Unit: the request-filter decision function (URL, resolved sender, toggle, override set) is pure; test
  the matrix, including the CORP-strip interaction, an unregistered frame (default deny while blocking is
  on), and two senders referencing the same image URL where one is allowed and one is blocked.
- E2e: seed HTML mail whose image points at a local HTTP server the test controls. With blocking on, open
  the message and assert the server got no request and the banner shows. Click `Load once`, assert exactly
  one request. Set `Always load`, relaunch, reopen, assert loading without a banner.
- A cancelled image load makes Chromium log a console error (`net::ERR_BLOCKED_BY_CLIENT`), and the boot
  fixture fails any test with renderer console errors. The task must reconcile the two: either cancel in a
  way that does not log, or teach the fixture a narrowly scoped allowlist for exactly this message.
- New screenshot artifact `remote-images-blocked.png`, added to the AGENTS.md list.

### Done when

With blocking on, opening mail produces zero image-fetch requests, overrides survive relaunch, and the
default-load behavior is byte-identical to today for users who never touch the toggle.

---

## T34: snippets

**Status: shipped (2026-08-31, `e4d428e`; cursor-marker review follow-ups in `1e3d082`).**

**Depends on:** T32 (manager pane) · **Unblocks:** nothing · **Spec:** F8

### Why

F8 in full: named reusable text blocks, inserted by palette or a `;trigger` typed inline, with an optional
subject and a `{cursor}` marker. This is the feature the Lexical decision was made for (M2-PLAN, editor
decision): expansion must be a single undoable step with correct caret placement, which needs a real
document model.

### Design (decided)

- **Schema bump to 23.** New `snippets` table; the same bump drops `outbox.remote_updated_at`, which is
  written and never read (KNOWN-ISSUES REF-5 says to fold the drop into the next bump). The table is
  additive and rides the AGENTS.md manual dogfood procedure. The drop is not additive, so it does not:
  AGENTS.md routes destructive changes through an explicit task-level migration design, and this paragraph
  is that design. The column has no reader, so the drop deletes nothing any code path uses; the operator
  still takes the procedure's backup first, runs its before/after checks, and applies everything with the
  version stamp in one transaction. Dogfood DDL:

  ```sql
  BEGIN IMMEDIATE;
  CREATE TABLE snippets (
    account_id TEXT NOT NULL,
    id         TEXT NOT NULL,
    name       TEXT NOT NULL,
    trigger    TEXT,
    subject    TEXT,
    body_html  TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, id)
  );
  CREATE UNIQUE INDEX idx_snippets_trigger
    ON snippets (account_id, trigger) WHERE trigger IS NOT NULL;
  ALTER TABLE outbox DROP COLUMN remote_updated_at;
  PRAGMA user_version = 23;
  COMMIT;
  ```

- **Snippets are app-global** (F18's scoping, rule 9). The table still carries `account_id` because every
  table does (D4); v1 writes the app sentinel so one snippet set serves every signed-in account.
- **Two insertion paths, one implementation.** The palette command `Snippet: <name>` and the inline
  `;trigger` both call the same composer insertion: replace the trigger text (if any) with the snippet
  body, place the caret at `{cursor}` or at the end, and commit it as one Lexical history entry so one
  `Mod+Z` reverses the whole expansion. `Mod+;` opens the snippet picker inside the composer (§5 already
  reserves it).
- **Trigger matching is deliberate, not eager.** A trigger fires when the user types the full `;word`
  followed by a space or Enter. No fuzzy matching inline; fuzzy lives in the palette.
- **Subject fills, never overwrites.** A snippet with a subject sets the composer subject only when the
  subject is empty.
- **Snippet bodies are untrusted** (rule 3): they pass the composer sanitize path on save and on insert.
- **The manager** is a T32 settings section: list, create, edit, rename, delete, with the same editor
  component the composer uses for the body.

### Testing

- Unit: trigger matcher (mid-word `;` does not fire, trailing space fires, unknown trigger inert);
  subject fill-only rule; sanitize on save.
- E2e (extend `ComposerPage`): type `;intro ` and assert expansion; one `Mod+Z` restores the literal
  `;intro`; `{cursor}` placement proven by typing immediately after expansion and asserting position;
  palette insertion into an empty composer; manager CRUD survives `boot.relaunch()`; a snippet with a
  subject does not clobber an existing subject.
- New screenshot artifact `snippet-manager.png`, added to the AGENTS.md list.

### Done when

F8's acceptance criteria hold: insertion under 50ms, `{cursor}` lands the caret, `;trigger` expansion is
one undo step. The DDL above is in the PR notes.

---

## T35: follow-up reminders

**Status: shipped (2026-08-31, `cbb899e`).** Schema v24, with durable send ordering added in v25; the dogfood DDL is below. Real-Gmail follow-up runs stay in T40.

**Depends on:** nothing · **Unblocks:** nothing · **Spec:** F9, F4 (snooze mechanics)

### Why

F9: "remind me if no reply". Send with a deadline; if nobody replies by then, the thread resurfaces at the
top of the inbox with a **Follow up** chip. Any reply cancels it. This is the last v1 feature that touches
the reminder machinery. The `reminders` table already has a `kind` column, defaulting to `'snooze'`, whose
primary key `(account_id, thread_id, kind)` lets a snooze and a follow-up coexist on one thread. T35 adds
the outbox deadline and durable reminder fields that identify the message being followed up.

### Design (decided)

- **Set at compose, created at send.** The composer footer gets a follow-up control (3 days / 1 week /
  custom, sharing the snooze natural-language parser), plus a palette command. The chosen deadline rides
  the outbox row, and the reminder row is written when the outbox transitions to `sent`, not when the send
  is queued. Commit the sent transition, the provider's final thread and message ids, and the reminder
  together in one transaction, including send-recovery paths. Creating it earlier would leave a live
  reminder behind an undone send. A later send with a new deadline replaces the same thread's follow-up;
  replaying the earlier send's completion must not replace that newer reminder.
- **Persist the originating message, not just the deadline.** Store its Gmail message id, canonical RFC
  Message-ID, and Gmail `internalDate` on the reminder. The original message's history event never counts
  as a reply. A distinct non-draft message qualifies when its `internalDate` is later; when dates tie,
  require `References` or `In-Reply-To` to identify the originating message. Do not order opaque Gmail ids
  or use the local send-completion time, which can move on retry. Older messages and replayed history do
  not cancel a newer follow-up. The comparison data stays on the reminder after sent outbox rows are
  pruned seven days later.
- **Resolve incomplete origins without retrying delivery.** `drafts.send` or exactly-once recovery gives
  the final message identity; the post-send read supplies its canonical headers and `internalDate`.
  That read remains best-effort for sending. If it fails, retain a pending reminder with an unresolved
  origin, show that its reply check is pending, and retry through the owning account's sync session.
  Do not fire or cancel that reminder by guessing an origin date. Once resolved, evaluate already-cached
  replies before arming the deadline, including a reply fetched before the sent transition committed.
- **Schema bump: persist the deadline and origin.** Composing and queued rows retain the nullable
  `follow_up_at` choice. The reminder columns below are nullable for existing snoozes; new follow-ups
  require `origin_message_id`, and cannot fire until their origin date is resolved. This is additive and
  follows the AGENTS.md manual procedure. Dogfood DDL, in one transaction, uses version 24 after T34's 23;
  swap the numbers if T35 lands first:

  ```sql
  BEGIN IMMEDIATE;
  ALTER TABLE outbox ADD COLUMN follow_up_at INTEGER;
  ALTER TABLE reminders ADD COLUMN origin_message_id TEXT;
  ALTER TABLE reminders ADD COLUMN origin_rfc_message_id TEXT;
  ALTER TABLE reminders ADD COLUMN origin_internal_date INTEGER;
  PRAGMA user_version = 24;
  COMMIT;
  ```
- **Cancel on any reply, through a new feed.** The existing wake path cannot carry this: the poller's
  `newMail` predicate requires `INBOX` and `UNREAD` and excludes `SENT` (`planCycle` in `sync/poller.ts`),
  because it feeds notifications, and "any participant" includes the user, whose second outbound message
  must also cancel. Add a separate feed over non-draft `messagesAdded` candidates with no other label
  filter, then apply the origin comparison above. Keep the notification predicate and snooze wake
  eligibility unchanged. An eligible reply cancels a pending follow-up or clears an already-returned
  follow-up's chip and priority, without undoing the reply's own Inbox membership.
- **Reconcile replies after history expiry.** Cancellation also runs against authoritative thread
  snapshots, not only history events. `recoverExpiredHistory` must refresh every thread with a pending
  or returned follow-up, including archived threads skipped by ordinary backfill. Compare its non-draft
  messages with the stored origin using the same function as incremental cancellation. Persist a
  per-account recovery-pending guard before these reads, and retain it across restart. While it is set,
  defer new follow-up returns until these checks finish. Persist cancellations
  before advancing the recovered history checkpoint; a failed or interrupted check keeps recovery
  retryable. Never treat a failed read as evidence of no reply. Ordinary snapshot refreshes perform the
  same comparison, so a reply cannot be missed merely because it was cached before the reminder existed.
- **Resurface like a snooze return.** At the deadline, the scheduler restores the thread to Inbox through
  the same reducer as snooze return (rule 6), marks it with the **Follow up** chip, and sorts it above
  normal mail in the list until it is triaged. Catch-up on boot applies (D2), subject to unresolved-origin
  and history-recovery checks above.
- **A pending snooze wins over the follow-up deadline.** If a follow-up becomes due while that thread is
  snoozed, leave the follow-up pending and keep the thread out of Inbox. Arm the next check for the snooze
  deadline, not the already-past follow-up deadline. When the snooze returns, settle its state and any
  overdue follow-up in one transaction and enqueue at most one Inbox restoration. This prevents
  `replaySnoozeReminderDelta` from hiding the returned thread on the next refresh. If snooze returns first,
  the later follow-up marks and prioritizes the thread when due without duplicating an Inbox mutation.
  If both are due at startup, use the same transaction. A qualifying reply still cancels the follow-up
  and uses F4's existing snooze-wake rules.
- **Triage updates both reminder kinds deliberately.** Archive or Move cancels a pending snooze, as today,
  and completes any returned follow-up. It also cancels an overdue follow-up that was waiting only for
  that snooze, so the scheduler cannot immediately reverse the user's archive or Move. An ordinary archive
  leaves a not-yet-due follow-up pending; Spam and Trash cancel it. Snoozing a returned follow-up makes it
  pending again until the new snooze returns. Undo and permanent-failure recovery restore the affected
  reminder snapshots together with the label delta. Refresh the scheduler after each such state change.
- **Visible in the reminders view.** Pending follow-ups list in the Snoozed view (`G` then `H`) alongside
  snoozes, labeled by kind. A thread with both kinds stays one conversation row, showing both deadlines
  and whether its follow-up is waiting for snooze return or an origin check.
- Timers run on `SchedulerTime` (rule 8).

### Testing

This task also owns GAP-1's wanted assertions, because it modifies exactly that path:

- Unit (poller): the originating sent message, older messages, and DRAFTs never cancel the reminder.
  Replaying an eligible reply is idempotent. A later inbound reply cancels it and retains the existing
  `wakeThread` behavior. A later `SENT` message cancels it without a snooze wake or notification. Cover
  equal-date reply headers, a reply
  cached before origin resolution, and a new follow-up followed by replay of the previous send's history.
- Unit (recovery): expire history while a follow-up is pending, return an archived thread containing a
  later reply through a snapshot, and prove cancellation before checkpoint advance. Interrupt and retry
  the pass, including a failed thread read; neither may produce a false return or lose the cancellation.
  Keep the origin comparison effective after pruning its sent outbox row.
- Unit (scheduler and sender): a due follow-up returns the thread and survives a restart; an undone send
  creates no reminder; normal send and exactly-once recovery create exactly one atomically. A failed
  origin read does not retry the send or fire the reminder. Cover both deadline orders, equal deadlines,
  and both deadlines missed while closed. Re-fetch the thread after return and prove it remains visible.
  Assert one queued Inbox restoration, no timer loop while snoozed, and reply cancellation during the wait.
- Unit (triage): archive and Move while an overdue follow-up waits for snooze, Spam and Trash before the
  follow-up is due, snoozing a returned follow-up, undo, and permanent-failure recovery. A future follow-up
  survives ordinary archive; completing a returned follow-up clears its chip and priority.
- Unit: every return, cancellation, undo, and recovery keeps `thread_mailboxes` and cached mailbox counts
  aligned with paged lists. Extend `db/isolation.test.ts` for new account-keyed reads, and account purge
  tests for the new reminder/outbox fields. App-global snippets and AI preferences survive sign-out.
- E2e: send with a follow-up under the seeded provider, advance fake time, assert the chip and the
  above-normal-mail sort. First replay the originating sent message through history and prove the
  reminder survives. Inject a later reply before the deadline and assert no resurfacing. Exercise expired
  history with a reply present only in the recovered snapshot. Snooze `t-roadmap`, inject inbound mail,
  and assert the returned chip (GAP-1's e2e). Also cover a follow-up due before snooze and both deadlines
  missed across `boot.relaunch()`, with a subsequent refresh proving the return remains visible.
- Remove GAP-1 from KNOWN-ISSUES in this PR.

### Done when

F9's acceptance criteria hold: only a subsequent reply cancels, including one found during history
recovery; a pending snooze postpones follow-up return without losing it; and returned follow-ups remain
visible and sort above normal mail until handled. The DDL above is in the PR notes.

### Schema revision 24 → 25: durable follow-up ordering

Follow-up replacement is ordered by the originating outbox row's creation time. That evidence must
survive the seven-day sent-row retention window, including after a reminder has settled, because startup
recovers older `sending` rows only after pruning. Version 25 stores the ordering value on the reminder;
the backfill copies it from retained outbox rows when available. This is additive and eligible for the
AGENTS.md manual dogfood procedure:

```sql
BEGIN IMMEDIATE;
ALTER TABLE reminders ADD COLUMN origin_outbox_created_at INTEGER;
UPDATE reminders
SET origin_outbox_created_at = (
  SELECT MAX(outbox.created_at)
  FROM outbox
  WHERE outbox.account_id = reminders.account_id
    AND outbox.rfc_message_id = reminders.origin_rfc_message_id
)
WHERE kind = 'follow_up' AND origin_rfc_message_id IS NOT NULL;
PRAGMA user_version = 25;
COMMIT;
```

---

## T36: AI writing foundation

**Status: shipped (2026-08-31, `b87a3ec`).** Default models per provider are recorded in `AI_PROVIDER_PRESETS` (src/shared/ai.ts).

**Depends on:** T32 (enable pane) · **Unblocks:** T37, T37A · **Spec:** F17, D2, §6

### Why

F17 provides explicit reply drafting and separately enabled inline autocomplete. This task builds their
shared provider client, key custody, consent controls, and fake-provider seam. The
split keeps each PR reviewable and puts the security-sensitive half (keys, network, guardrails) in its own
diff.

### Design (decided)

- **The LLM client lives in the main process** (`src/main/ai/`). D2 says requests go directly from the
  client to the chosen provider, and the renderer-sandbox invariant means the renderer is not that client.
  Main is the right process rather than the utility: the key comes from `safeStorage`, which is main-only,
  and main must not acquire a SQLite handle. Account and stored-context reads use the utility bridge.
  Streaming crosses to the renderer as typed IPC events (`ai:generate` → chunk events → done/error, plus
  `ai:cancel`), following the acknowledged-toast pattern from T18. Requests distinguish reply/refine from
  autocomplete, and main checks the corresponding enable flags before constructing any network request.
  Cancellation, deadlines, and late-response rejection belong to this shared transport; autocomplete's
  tighter limits and context builder are owned by T37A.
- **Keys are encrypted with `safeStorage`, never stored in SQLite.** The `settings` table is plaintext.
  Follow the OAuth tokens' encrypted-file pattern, but keep LLM credentials separate. Removing a key in
  the UI deletes its stored ciphertext without changing OAuth credentials (F17 guardrail).
- **Two wire protocols, one interface:** the Anthropic Messages API and OpenAI-compatible chat completions
  (which covers Ollama and LM Studio for local models). Provider, base URL (for compatible endpoints), and
  model are user-selectable with a sensible default per provider, recorded in code.
- **Separate consent for separate traffic.** The master AI control is off by default. Its reply-drafting
  disclosure covers the current thread, voice profile, and optional style examples sent on invocation.
  Autocomplete has its own default-off opt-in, disclosing repeated requests containing unsent authored
  body text plus the current reply thread while typing and possible provider charges. T37A connects that control to the composer;
  enabling reply drafting alone never enables it. The settings UI and palette use the same consent flow.
  Disabling autocomplete cancels only its work; disabling master AI or removing the key cancels both,
  drops late responses, and prevents further requests. Explain that already-transmitted content cannot
  be recalled. Neither request payloads nor generated text may appear in logs.
- **Voice profile** (tone preset plus free-text standing rules, and the voice-matching toggle) stores in
  the `settings` table. It contains no mail content, so plaintext storage is fine. F18 scopes the provider
  key, model choice, voice profile, and enable toggles app-global (rule 9): one configuration serves every
  signed-in account. Style examples are drawn only for explicit replies from the owning account's sent
  mail (T37). Autocomplete uses the current draft's authored-body excerpt and current reply thread, never style examples.
- **Test seam:** `attn:test:installFakeAiProvider` in `src/main/testIpc.ts`, disabled outside the env seam
  like every other seam. It scripts chunks, delayed completions, errors, and late responses after cancel;
  records request purpose, payload, and cancellation; and is the only way e2e exercises F17. Payload
  recording exists only under this synthetic test seam. Real endpoints stay out of e2e.

### Testing

- Unit: request shaping for both protocols and purposes; autocomplete accepts current-thread context but
  rejects reply-only style examples; key round-trip and deletion against a fake `safeStorage`; disabled state short-circuits before
  any network object is constructed; disabling during a request aborts it and ignores late chunks.
- E2e: enable flow through the settings pane with the fake provider; disable and assert the seam records
  zero requests when T37's command is invoked (this assertion lands here as a placeholder command and is
  strengthened in T37). Autocomplete consent remains off after enabling reply drafting and across
  relaunch; its own enable/disable and payload assertions land in T37A.

### Done when

A key can be added, used by a scripted generation round-trip in tests, and removed; the enable screen shows
the disclosure text; with the feature off, no code path reaches a provider.

---

## T37: AI reply drafting in the composer

**Status: shipped (2026-08-31, `12be729`).** Real-provider runs stay in T40.

**Depends on:** T36, T32B (signature integration) · **Unblocks:** T37A · **Spec:** F17, F6, §5

### Why

The explicit-invocation part of F17: generate a reply into the composer as a fully editable draft, refine
it with a one-line instruction, and never auto-send.

### Design (decided)

- **Shortcut: `Mod+J`**, command name `Draft AI reply`, assigned in SPEC §5 and F17. The palette inventory
  test must catch a future collision.
- **Where it works:** in the reader and in an open inline reply/reply-all composer. Invoked from the reader
  with no composer open, it opens the inline reply composer first, then streams into it. It is unavailable in a
  new-message or forward composer in v1; F17 scopes whole-body generation to replies. T37A's short
  completions work in all composer modes under separate consent.
- **Streaming is editable and one undo step.** Chunks append into Lexical as normal editable content, with
  history coalesced so a single `Mod+Z` removes the whole draft (F17: insertion is undoable like any other
  edit). The insert passes the composer sanitize path (rule 3).
  If the authored region already contains text, send it as an immutable prefix and append only the generated
  continuation; one undo removes that continuation while preserving the user's original text.
  Insert above the Gmail signature and T32B footer. Generation, refine, and undo preserve those regions,
  including user edits or removal; generated output must not add another automatic signature/footer.
- **`Esc` cancels cleanly:** it aborts the stream via `ai:cancel` and keeps the text already inserted,
  still as one undoable step. A second `Esc` behaves like any composer `Esc`.
- **Inline refine:** after a draft lands, a one-line instruction field ("shorter", "more formal")
  regenerates. The regeneration replaces the prior AI-inserted region as a single undoable step; text the
  user edited by hand is theirs, so refine is offered only while the AI region is unedited.
- **Voice matching:** when the toggle is on, a handful of the user's recent sent replies are selected
  locally from the store of the account that owns the draft (F18: replies bind to the thread's owning
  account) and sent as style examples. Exclude the conversation being answered from style examples so
  later sent replies and their quotes cannot bypass the selected-message cutoff. When the toggle is off,
  no additional sent-mail style examples may appear in the request. Current-thread messages through the
  reply's source remain valid context. The recorded payloads in `e2e/ai-context.spec.ts` cover reply,
  reply-all, refine, and autocomplete after reopening a middle-message draft. These examples are never
  passed to T37A.
  Examples contain authored text after removing recognized HTML and plain-text quotes, forwarded trails,
  and signatures. Empty results are skipped before counting examples; HTML cleanup never falls back to
  the original text alternative. The same recorded payload tests cover both HTML and plain-text examples.
  Candidate selection reads only metadata for the newest 200 nonempty rows within the input size limit.
  Bodies are loaded individually after byte-size checks, capped at 64 KiB per candidate and 256 KiB
  per invocation. Oversized examples are
  skipped whole, and the text extractor applies the same per-candidate guard before trimming or parsing.
- Starting reply generation or refine cancels pending autocomplete and clears its preview. Autocomplete
  stays suspended until generation ends and the user resumes typing; AI-inserted chunks cannot trigger it.
- In an empty inline reply/reply-all composer, show a transient `Tip: Hit Mod+J for AI` placeholder only
  when AI writing is enabled and the configured provider's required key is present. Keep it outside the
  editor document and hide it after the first authored content. Do not advertise the reply-only command in
  new-mail or forward composers.
- **Never auto-sends.** Output lands behind the normal send flow, undo send included. Generation must not
  block the UI (F17 acceptance), and it yields to interactive work (rule 7).

### Testing

- E2e with the fake provider: `Mod+J` in the reader opens the reply composer and streams the scripted
  draft; the result is editable and sends through the normal outbox; one `Mod+Z` removes it; `Esc`
  mid-stream stops cleanly with partial text present; refine replaces the draft; with voice matching off,
  no recorded payload contains extra sent-mail style examples; with the feature disabled, `Mod+J` shows
  the disabled hint and the seam records zero requests.
- Unit: sent-reply selection for style examples (recency, own-reply filter, count cap).
- E2e: generation, refine, and undo preserve the Gmail signature and optional Attn footer, including
  footer edits and deletion. Inspect the captured send body for duplication.
- New screenshot artifact `ai-draft.png`, added to the AGENTS.md list.

### Done when

F17's reply-drafting acceptance criteria hold end to end under the seam: zero traffic when disabled,
`Esc` cancels cleanly, voice-matching-off sends no extra style examples, and insertion is one undo step.

---

## T37A: inline AI autocomplete

**Status: shipped (2026-08-31, `2a50fda`; perf evidence updated 2026-09-03).** Real-provider runs stay in T40; on-hardware paint metrics are recorded in T40-EVIDENCE.

**Depends on:** T36 (provider and consent), T37 (composer generation lifecycle) · **Unblocks:** nothing · **Spec:** F17, F15, §5, §7

### Why

Full reply drafting starts from a command and writes the reply body. Autocomplete helps when the user
already knows what to say: offer the next few words as they type, with no insertion until they accept.
Repeated transmission of an unfinished draft requires its own consent and request limits.

### Design (decided)

- **Scope and settings:** new messages, replies, reply-all, and forwards, in the existing body editor.
  Connect T36's separate default-off autocomplete control to the editor, with enable/disable commands and the
  F17 privacy/cost disclosure. Both master AI and autocomplete must be enabled. Use the configured
  provider/model; no new service or mailbox index. Persist only the preference, never suggestion state.
- **Preview, then insertion:** stream one plain-text sentence continuation in gray at a collapsed caret,
  with no line breaks and a 120-character cap. Stop at the first sentence-ending punctuation even if the
  provider returns more. Update the transient preview as provider chunks arrive;
  never stream those partial words into the document. Render the preview outside the persisted Lexical
  document, anchored to the caret through wrapping and scrolling. It must not affect selection, copying,
  exported HTML, autosave revisions, Gmail mirroring, or sending. Acceptance inserts plain text in the
  current editable text context as one undoable transaction; undo restores the prior text and caret.
- **Keyboard ownership:** `Tab` accepts only a current visible preview while the body owns focus. `Esc`
  clears a visible preview without closing; it also cancels pending work before the normal close path
  when no preview is visible. With no preview, `Tab` retains its normal behavior. `Shift+Tab`, arrow keys,
  and `Enter` keep normal navigation/editing. Recipient completion, palette, snippet picker, and dialogs
  own their keys when active; never install a global Tab interceptor. Route accept/dismiss through the
  composer's keyboard handling, register enable/disable commands in the palette, and update the cheat
  sheet. Opening a picker or palette invalidates the preview.
- **Trigger:** after a deliberate body-typing edit at the end of the authored body, wait 300ms of inactivity.
  Require an unfinished, nonempty authored prefix, no authored text after the caret, a collapsed selection
  in ordinary editable text, and a focused foreground composer. Mount,
  draft restore, focus alone, AI chunks, snippet insertion, undo/redo, and suggestion acceptance/dismissal
  do not trigger requests. Suppress requests during IME composition, selections, T37 generation/refine,
  open pickers/dialogs, and inside quotes, signatures, T32B's footer, tables, or opaque preserved regions.
  A subsequent deliberate typing edit can trigger another request.
- **Local greeting:** before the provider trigger, recognize `Hi`, `Hello`, or `Hey` at the start of an
  otherwise empty body and immediately offer the primary recipient's first display name. This path is
  deterministic, makes no provider request, requires no AI consent, consumes no rate-limit budget, and uses
  the same transient preview plus body-owned `Tab`/`Esc` handling.
- **Bounded context:** build a separate autocomplete payload from the authored body, up to 2,000 plain-text
  characters before the caret and 500 after. Exclude protected quote/signature/opaque nodes from extraction,
  not just from display, and preserve the cursor boundary when truncating. Add the current subject, selected
  tone, and standing rules; for replies, also add the current cached thread through the message being
  answered. Do not include recipients, attachment content or metadata, signatures, or unrelated sent-mail
  style examples, and do not fetch mail to fill the context. Ambiguous imported regions are excluded, even
  at the cost of fewer suggestions.
- **Bounded work:** main enforces one autocomplete request in flight app-wide, at most one start per second
  and 20 starts per rolling minute. Enforce size caps and purpose-specific consent at the IPC boundary too.
  The renderer coalesces the latest replacement until a one-second cooldown expires; the rolling cap and
  provider failures still skip without automatic retries. Abort and discard work after five seconds from
  dispatch. Anthropic autocomplete explicitly disables model thinking while reply and refine retain the
  provider default. T36 handles aborts; injected clocks exercise debounce, rate limits, and deadlines.
  A slow/offline provider or rate limit simply yields no suggestion. Report persistent configuration
  errors in settings without recurring composer toasts. Explicit reply generation takes priority.
- **Reject stale results:** bind each request to the account generation, composer instance, draft id,
  editor revision, caret position, and request sequence. Resolve account ownership through the utility
  bridge; never trust a renderer-supplied account id alone. Clear the preview and cancel work on any edit,
  selection/caret change, blur/window deactivation, draft close/send/discard, account change, provider/key
  change, or disable. Recheck identity, consent, and editor state both on receipt and on acceptance.
  Abort is best effort; even an uncancellable late result must be ignored. A dismissed result cannot
  reappear without fresh typing, and no timer may keep a closed composer active.
- **Ordinary editing wins:** neither requests nor previews may delay input, autosave, or send. Use readable
  secondary text in all four themes, announce availability without stealing focus or announcing each
  token, and keep the caret and text layout stable. Only accepted text joins the normal draft/outbox flow.

### Testing

- Unit with injected time and the fake provider: 300ms debounce, one-in-flight and both rate caps, 1,500ms
  deadline, no retry loop, and disabling or editing while a response is queued. Assert late results fail
  every identity check, including a remounted composer with the same draft id. Pin bounded payloads with
  quote/signature/opaque regions, T32B's footer, current-thread mail, and cross-account sent mail present.
  Only the current thread may accompany the excerpt.
- E2e: first enable reply drafting and type; autocomplete records zero requests. Opt in separately and
  cover new mail, reply, reply-all, and forward; accept with Tab, edit, undo, dismiss with Esc, and continue
  typing. Assert caret restoration, normal Tab/Shift+Tab/arrow/Enter behavior, and recipient/snippet/palette
  precedence. Exercise IME, non-collapsed selection, blur, T37 generation/refine, provider failure, timeout,
  and disabled state after relaunch. No real LLM calls.
- E2e durability and races: leave a preview unaccepted, then save/close/reopen, copy, mirror, and send;
  inspect the stored draft and captured provider send payload to prove the preview was absent. Accept a
  suggestion and prove it follows ordinary autosave and send. Hold a fake response, close the composer,
  switch accounts through F18's existing guard, open another draft, and release it; it must never appear.
  Also release stale responses after send/discard, caret edits, disable, or key removal.
- Performance: extend the composer probe with autocomplete enabled and a delayed fake provider; keystroke
  and acceptance-to-paint remain below 16ms (§7). Record real-provider suggestion latency separately at
  T40, along with request counts; do not make network speed a condition of passing local editing tests.
- Inspect `ai-autocomplete.png` and `ai-autocomplete-light.png`, covering caret placement and wrapping in
  dark and light modes; cover legibility in all four themes and add artifacts to AGENTS.md when implemented.

### Done when

F17's autocomplete acceptance criteria pass: separate consent, bounded authored-body plus reply-thread context, fresh
suggestions only, correct Tab/Esc/undo behavior, no persistence before acceptance, and no typing slowdown.

---

## T38: Windows unread badge overlay

**Status: shipped (2026-08-31, `1ed0d80`); revised after Windows dogfood (2026-09-01, `583f273`, #104).** The Windows
visual check stays in T40.

**Depends on:** nothing · **Unblocks:** nothing · **Spec:** F12

### Why

M1 shipped the Windows badge as a static icon with the count in its tooltip and recorded a rendered
numeric overlay as M4 packaging polish. Real Windows dogfood showed that the first `99+` treatment squeezed
three glyphs into too little of the fixed 16px overlay and that feeding an assumed RGBA buffer through
Electron's platform-dependent bitmap decoder swapped the intended red to blue. Slack demonstrates the
more legible Windows convention: fill nearly the entire overlay with a red circle, keep single digits large,
and use a short cap instead of shrinking the type.

### Design (decided)

- Positive Windows counts render a high-contrast red numeric circle at 2x of the fixed 16px overlay slot;
  zero clears it. Counts `1`–`9` use one large glyph and higher values show `9+`. The generated PNG avoids
  platform-dependent raw bitmap channel order, while the accessible overlay description keeps the exact
  count. macOS keeps the native numeric `setBadgeCount` treatment.
- The count itself is not this task's business: M5's A2/A4 already sum it across signed-in accounts
  and cover notification routing (F12/F18).
- A default-on, app-wide `unreadBadgeEnabled` setting clears/restores the Windows overlay or macOS Dock
  badge immediately, persists across relaunch, and has a palette command. It does not pause notifications.

### Testing

- Unit: validate the 32px circle and labels, the `9+` visual cap, PNG caching, zero-clears behavior, exact
  Windows description, and disabled clearing on both macOS and Windows. These run on any OS.
- The e2e suite runs on macOS and cannot see a Windows overlay. Manual evidence on a Windows machine
  confirms the numeric badge at positive/zero counts; e2e covers setting persistence and its palette command.

### Done when

The unit matrix is green and the Windows manual check is ticked in the T40 checklist.

---

## T39: auto-update, signing, and notarization

**Status: code parts shipped (2026-08-31, `8ace1ab`); publishing workflow and About surface shipped 2026-09-04; migration support followed in PR #114; operator-credential parts open.** The state machine, distribution metadata, and `package:verify --release` are in and tested. The Release workflow verifies, signs, notarizes, stamps the target and minimum migratable schemas into `latest*.yml`, publishes the versioned assets, and updates the rolling `update-feed`. It also maintains the current `feed-schema-<n>` as a bridge for clients with the former exact-schema updater. The ordinary quit and explicit restart both revalidate the cached release before installation. Settings → About shows the version, schema, build kind, feed, last check, and update actions. [RELEASE.md](RELEASE.md) is the runbook. The Apple and Windows signing credentials and the public feed-repository decision remain operator work recorded in T40.

**Depends on:** operator-supplied credentials (below) · **Unblocks:** T40 · **Spec:** §6 Packaging

### Why

Personal-build packaging shipped at M1 exit: `package.yml` produces ad-hoc-signed macOS artifacts and an
unsigned Windows installer. v1 needs the rest of §6 Packaging: real signatures, notarization, and
auto-update from GitHub Releases.

### Operator prerequisites (start these first; they gate the task)

1. An Apple Developer ID Application certificate and notarytool credentials (Apple ID or App Store Connect
   API key), as CI secrets.
2. A Windows code-signing certificate, as a CI secret.
3. **A decision the task must record before wiring the feed:** whether the release repository is public.
   electron-updater reads a public GitHub Releases feed anonymously; a private repo needs a token or a
   separate public release repo. Decide, and write the choice into this section.

### Design (decided)

- **Signing comes before auto-update inside this task.** Squirrel.Mac rejects unsigned updates, so an
  unsigned build that checks for updates is worse than none. Order of landing: macOS Developer ID signing +
  notarization in `package.yml`, then Windows signing, then the updater.
- **Keep personal and public-release builds separate.** Existing `package:dir`, `package:mac`,
  `package:mac:all`, and `package:win` remain usable without signing credentials. Their default mode is
  personal: ad-hoc signing on macOS, unsigned Windows artifacts, and no updater. Add an explicit release
  mode for the publishing workflow, with packaged metadata declaring the distribution mode and schema
  version. Missing metadata defaults to personal; `app.isPackaged` alone never enables updates. A failed
  release signature check must fail publication, not silently fall back to personal mode.
- **Updater:** electron-updater against GitHub Releases. Check on launch and every 6 hours
  (`SchedulerTime`, rule 8). Download in the background at background priority (rule 7). When a version is
  ready, surface a quiet toast and a palette command `Restart to update`. Never force a restart; a normal
  quit applies the update. Construct the updater only in packaged, non-seeded release builds. Personal,
  dev, and e2e builds neither check nor install a cached update. Route update restarts through the existing
  awaited shutdown so draft mirroring and sending quiesce before the installer takes over.
- **Automatic updates carry schema migrations.** The rolling feed declares the target schema and the
  oldest schema that release can migrate. Before download and again before installation, require the open
  database to fall inside that range. `openDatabase` then applies every ordered step in one transaction
  and checks database integrity before commit. Missing metadata, migration gaps, unsupported old profiles,
  and databases newer than the binary fail without deleting the profile or local-only state.
- **Verification follows the build mode.** `npm run package:verify` retains runtime-asset and native-module
  checks for every build, including unpacked `package:dir` smoke tests. The release workflow additionally
  invokes `npm run package:verify -- --release`, which requires release metadata, a valid Developer ID
  signature and notarization ticket on macOS artifacts, and an Authenticode signature on the Windows
  installer. It also checks feed and packaged schema agreement. Personal verification requires the
  updater-disabled metadata but no certificate or notarization credentials. Expired or missing release
  credentials fail the release workflow without breaking personal packaging.
- **Scope guard:** signing does not change the OAuth posture. Distribution stays dev-mode (each user's own
  OAuth client, decision #2); Google verification remains deferred.

### Testing

- Unit: the update state machine (idle → checking → downloading → ready → applied, plus error/backoff) with
  injectable time and a fake feed. Cover release, personal, dev, seeded, and missing-mode gating; a
  packaged personal build must construct no updater and make zero feed requests. Reject missing schema
  metadata, incompatible targets, and stale cached updates before download or install. Verify that a
  restart awaits the existing worker shutdown before invoking the installer.
- Verification fixtures: valid personal artifacts pass without signing credentials; release artifacts
  with absent or invalid signatures, missing notarization, or inconsistent schema metadata fail. A
  personal artifact presented to `--release` fails rather than being published.
- Real updates cannot run under the e2e harness. Manual evidence for T40's checklist: on each OS, install
  build N with populated mail, settings, reminders, and composing and queued outbox rows. Publish a newer
  build with the same schema to a test feed, observe download and update-on-quit, and verify the profile
  opens with its data intact. Use synthetic mail and a profile without Gmail credentials for queued-send
  checks, without the runtime test seam that disables updates. The test must not send real mail. Offer
  a newer incompatible-schema build and missing-schema metadata. Neither may download or replace the
  installed app. Record a credential-free personal packaging smoke
  and confirm it performs no update traffic on both OSes.

### Done when

Public-release installers verify as signed, macOS release artifacts are notarized, and release
verification enforces schema compatibility. Personal packaging still works without credentials and
cannot auto-update. T40 records the populated-profile update and incompatible-update rejection on both
OSes.

---

## T40: M4 exit and v1 sign-off

**Status: in progress (2026-08-31).** Engineering evidence and open manual items are recorded in [T40-EVIDENCE.md](T40-EVIDENCE.md); the harness-checkable boxes are ticked there, the real-OS/real-Gmail/credentialed ones remain open.

**Depends on:** every task above · **Unblocks:** the v1 tag

### Why

M4 is the last milestone, so its exit list is also v1's. Earlier milestones left manual items open on
purpose (real-OS and real-Gmail checks that the harness cannot run); they come due here, once, together.

### The exit checklist

Feature evidence (this milestone):

- [ ] Settings work with two accounts: reorder and relaunch, preserve the active view, Sign out with
      Delete/Keep, and retain deletion-failure warnings. Pause/resume covers both accounts on both OSes,
      even without a tray icon. Login and menu-bar toggles have real-OS evidence.
- [ ] T32's intermittent notification-focus failure is fixed with deterministic regression coverage;
      closing a composer and switching to the notified account opens its pending conversation reliably.
- [ ] Historical sync limit: independently change an account's cap, resume after relaunch, lower without
      deleting mail, and verify capped coverage plus Gmail search. Expanded history includes attachment
      flags, and the other account keeps polling and sending. Record disk/time expectations for All mail.
- [ ] Optional Attn footer: per-account opt-in, correct placement with and without a Gmail signature,
      editable/removable in every composer mode, and unchanged through relaunch, Gmail round trips, and
      undo send. Untouched drafts remain unmirrored; AI writing preserves the footer and its removal.
- [ ] Real-Gmail follow-up run: send with a 3-day follow-up from a dogfood profile, reply from another
      account, confirm cancellation; let a second one expire and confirm resurfacing. Confirm the sent
      message's own history event does not cancel either reminder, and exercise a coexisting snooze.
- [ ] AI drafting against one real provider (any, including a local Ollama): enable, draft, refine, send,
      disable, and confirm zero traffic after disable (proxy or provider dashboard).
- [ ] Autocomplete against a real provider: separate opt-in, new mail/reply/forward suggestions, Tab/Esc
      and undo, no unaccepted text in saved or sent mail, and zero typing-triggered requests after disable.
      Inspect the bounded payload with synthetic draft text, record suggestion latency and request counts,
      and confirm a slow/offline provider does not delay typing or sending.
- [ ] Windows numeric badge plus cross-platform disable/enable manual check (from T38).
- [ ] Signed/notarized install and same-schema update of a populated profile on both OSes; incompatible
      or missing schema metadata is rejected without changing the installation or local data (from T39).
- [ ] Credential-free personal packaging on both OSes, with no updater traffic or cached installation.
- [ ] Every new screenshot artifact inspected: `settings.png`, `settings-sync.png`, `cheat-sheet.png`,
      `composer-attn-signature.png`, `composer-attn-signature-light.png`, `remote-images-blocked.png`,
      `snippet-manager.png`, `ai-draft.png`, `ai-autocomplete.png`,
      `ai-autocomplete-light.png`.

Inherited manual items (owed by earlier milestones, still open as of 2026-08-30; verify against their plan
docs and tick or strike with evidence):

- [ ] M1's real-OS notification click-through smoke (M1-PLAN exit checklist).
- [ ] M2's real-Gmail bootstrap, exactly-once, and hydration observations (M2-PLAN T20).
- [ ] M2's one-week sole-client dogfood run, extended to exercise snippets, follow-ups, the Attn footer,
      AI drafting, and autocomplete.
- [ ] M5's remaining A7 real-Gmail two-account dogfood observation is recorded: add an account during
      indexing, observe preemption, notification routing, and the badge sum. Its implementation and
      executable isolation audit have shipped; preserve those checks for every new M4 account-scoped read.

Bookkeeping:

- [ ] SPEC §8 status paragraph updated; the M4 bullet marked done.
- [ ] KNOWN-ISSUES re-verified: every entry either still true (re-stamp) or removed by a named PR.
- [ ] `npm run e2e:perf` is green on the release build with the 10k + 1k two-account profile, including
      warm-switch p95. Run `npm run e2e:perf:scale` for the 40k-thread bounded-read checks too. Record the
      machine and results; §7 budgets must hold with all M4 features enabled. Neither profile alone proves
      million-message performance, and M5's documented shared-container misses are not waived budgets.

### Done when

Every box is ticked or explicitly struck with a recorded reason, and the v1 tag is cut from a green
`npm run verify` on `main`.

---

## Out of scope for M4

Multi-account implementation belongs to M5 (F18, §9 #21) and has shipped. Its remaining real-Gmail
observation stays in M5; T32 owns the settings-only reorder follow-up.
The v1.1 items stay v1.1: the global-hotkey quick panel and custom themes. Send later stays v1.5 (F7, the
companion Apps Script). Google OAuth verification stays deferred (decision #2). Read statuses
stay v2 (D2). Full keyboard remapping stays post-v1. AI beyond explicit reply drafting and separately
enabled inline autocomplete (summaries, auto-triage, semantic search) stays v2+; T36's provider client is
not an invitation to process the mailbox in the background, which F17 forbids.

## Open questions

| Question | Why it matters | Decide by |
|---|---|---|
| Public release repo or private-feed workaround for auto-update? | Gates the release workflow, not the code: T39 landed with the feed read from packaged metadata (`ATTN_RELEASE_FEED=owner/repo` at release-package time), so the operator decision is deferred without blocking wiring | Before the first published release; record the chosen repo here |
| ~~Default model per provider~~ | Resolved at T36: recorded in code as `AI_PROVIDER_PRESETS` (src/shared/ai.ts) and shown on the settings pane; F17 keeps naming no model | — |

The mailbox-size posture is resolved by SPEC §9 #22 and PR #98. T32A supplies its deferred user control;
T40 retains the performance and real-mailbox evidence requirements.
