# M4 Implementation Plan: Power Finish

**Audience:** the engineers building M4. Same contract as [M1-PLAN.md](M1-PLAN.md), [M2-PLAN.md](M2-PLAN.md),
and [M3-PLAN.md](M3-PLAN.md). Every task is one PR. Nothing is done until `npm run verify` is green. "Spec F8"
means a section of [SPEC.md](SPEC.md) (v0.17). Read the section before starting the task.

**Basis:** SPEC §8 M4, F8 (snippets), F9 (follow-up reminders), F12 (badge polish), F15 (settings), F17
(AI reply drafting), §6 Packaging (auto-update, signing, notarization), §9 #5 (remote images), and the
deferrals the earlier plans parked here: the settings surface (M1-PLAN T9/T8 notes), the remote-image block
toggle (M1-PLAN, T11 notes), the Windows numeric badge overlay (M1-PLAN accepted deviations), and the
`Mod+/` cheat sheet (the two "lands at M4" stubs in `MailHeader.tsx`).

**Goal:** M4 turns a daily-drivable triage client into a finished v1. Three power features land (snippets,
follow-up reminders, AI drafting), every deferred toggle gets its settings home, and the packaged app learns
to update itself with real signatures. M4 is the last milestone before the v1 tag, so it ends with a
sign-off task that rolls up every outstanding manual check.

## Task list

| Task | State | Blocks |
|---|---|---|
| T32 settings surface and cheat sheet (F15) | planned | T33, T34's manager, T36's enable pane |
| T33 remote-image control (§9 #5) | planned | nothing |
| T34 snippets (F8) | planned | nothing |
| T35 follow-up reminders (F9) | planned | nothing |
| T36 AI drafting foundation (F17) | planned | T37 |
| T37 AI drafting in the composer (F17) | planned | nothing |
| T38 Windows numeric badge overlay (F12) | planned | nothing |
| T39 auto-update, signing, notarization (§6) | planned | T40's update-in-place check |
| T40 M4 exit and v1 sign-off | planned | the v1 tag |

**Why this order.** T32 goes first because three other tasks hang panes on it: T33's toggle, T34's manager,
and T36's enable screen. F17 is split in two on purpose. As one task it would be the largest PR in the
repo's history (provider client, key storage, enable screen, streaming, voice, refine), and M2 already set
the precedent of splitting the composer into T14A through T14E. T39 is independent of everything else but
has operator lead time (certificates, notary credentials), so start its prerequisites in week one even if
the code lands late.

**What M4 does not absorb.** Multi-account (F18) is M5, planned in [M5-PLAN.md](M5-PLAN.md) and running in
parallel; SPEC §8 says the two milestones may interleave and v1 ships only when both exit. M4 tasks touch
none of M5's surfaces, but F18's scoping rules bind M4's new state (global rule 9), and T32 and T38 note
where they meet M5's shipped work. The KNOWN-ISSUES gaps stay in KNOWN-ISSUES, with one exception: GAP-1's
wanted assertions ride T35, because T35 changes the exact poller path GAP-1 describes.

---

## Global rules (carried from M3, still binding)

1. **No runtime compatibility-migration framework.** `src/main/db/schema.ts` is the single snapshot and
   every schema change bumps `CURRENT_SCHEMA_VERSION`, currently 21. T34 and T35 each bump it (T34 to 22,
   T35 to 23; if T35 lands first the numbers swap) and publish their dogfood DDL in their sections. A real
   dogfood profile gets the manual additive upgrade in AGENTS.md. T39 permits automatic updates only
   within one schema version; a schema-changing release needs a separate upgrade procedure.
2. **IPC has three parts:** main handler, preload bridge, and the typed channel map in `src/shared/`. All in
   the same commit.
3. **Mail content is untrusted**, incoming and outgoing alike. In M4 this extends to LLM output: an AI draft
   enters the composer through the same sanitize path as pasted content.
4. **Select on `data-testid`** in e2e.
5. **Every user-facing action is a registered command** (F5). The palette inventory test asserts this, so a
   new settings control without a command is a red test, not a review comment.
6. **One reducer, two sources.** Nothing in M4 may add a second write path for mail state. Follow-up
   resurfacing (T35) goes through the same reducer as snooze return.
7. **Interactive work outranks background work.** AI streaming (T37) and update downloads (T39) must not
   delay sends, action replay, or polling.
8. **Time is injectable.** Every new timer takes `SchedulerTime` from `src/main/time.ts`. T35's follow-up
   deadlines and T39's update-check interval both qualify. No test waits on wall-clock time.
9. **New state declares its account scope** (F18, in v1 since §9 #21). Per-account state carries the owning
   `account_id`; app-global state uses the settings sentinel (`APP_SETTINGS_ACCOUNT_ID`). F18 already
   decides for M4's features: snippets, the F17 provider key and voice profile, the undo-send delay,
   auto-advance, and the remote-image preferences are app-global; reminders, drafts, and outbox rows are
   per-account.
10. **If your task changes the verify pipeline, harness behavior, or the screenshot-artifact list, update
    AGENTS.md in the same PR.**

---

## T32: settings surface and keyboard cheat sheet

**Status: planned.**

**Depends on:** nothing · **Unblocks:** T33, T34, T36 · **Spec:** F15, F16, D6, §5

### Why

Every settings-shaped decision since M1 has been deferred to "the M4 settings surface", and the account
menu ships two dead items whose tooltips literally say so (`MailHeader.tsx`, the `Settings` and
`Cheat sheet` entries). The undo-send delay has been configurable in the database since M2
(`outbox/queue.ts` reads `undoSendDelaySeconds`) with no way to set it. Auto-advance direction is
hardcoded. The F16 macOS menu-bar icon has no toggle. This task builds the surface those switches live on.

### Design (decided)

- **A full-window settings view**, not a dialog. It replaces the content region the way the new-message
  composer does: the prior list or reader stays mounted and hidden, and `Esc` or Back restores it exactly.
  The sidebar stays visible. Open it with `Mod+,`, the account-menu item, or the palette command
  `Open settings`.
- **Sections at ship time:** Accounts (the signed-in roster with add, remove, and `Mod+1..9` reorder per
  F15 v0.17 — the behaviors behind those controls are M5's A-tasks, so T32 gives them their settings home
  and wires whatever M5 has shipped by then, without reimplementing account management), Triage (undo-send
  delay 0/5/8/10/20/30s; auto-advance direction next/previous/back-to-list), Notifications (per-split
  toggles link to the existing T27 rule manager in `SplitRuleManager.tsx`; do not rebuild it), Background
  (launch at login; macOS menu-bar icon, default off, wired to the existing tray code in `background.ts`),
  Appearance (the four F14 themes). T33, T34, and T36 each add their own section in their own PR.
- **Storage:** the existing `settings` table through `src/main/settings.ts`. Every key this task adds is
  app-global per F18's scoping, so it lives under the table's app sentinel, exactly how
  `undoSendDelaySeconds` and `launchAtLogin` are stored today. New keys: `autoAdvanceDirection`,
  `menuBarIcon`.
- **Every control is also a palette command** (rule 5): `Set undo send delay…`, `Set auto-advance…`, and so
  on. The theme commands from T30 already exist; the settings pane reuses them.
- **The cheat sheet (`Mod+/`)** is a dismissable overlay listing the §5 keyboard map. It renders from the
  command registry, not from a hardcoded table, so a new command with a shortcut appears without editing the
  sheet. It groups by the registry's existing categories. `Esc` closes it. Both dead account-menu items are
  replaced by the real entries in this PR.

### Implementation guide

- Settings reads and writes cross the bridge as one typed `settings:get`/`settings:set` pair with a
  key allowlist in `src/shared/`, not one channel per key.
- Auto-advance direction is consumed where triage advance already happens in `Inbox.tsx`; the setting
  changes the target row selection, nothing else.
- The menu-bar toggle only installs or removes the macOS `Tray`. Windows tray behavior is unchanged (F16
  says the Windows tray is always present).

### Testing

- E2e: open settings by `Mod+,`, by account menu, and by palette. Change the undo-send delay, send a seeded
  message, and assert the countdown uses the new window. Change auto-advance to previous and assert the
  triage advance direction. Relaunch with `boot.relaunch()` and assert both persist.
- E2e: `Mod+/` opens the cheat sheet, shows the `G` chords, and `Esc` closes it. A registered command with
  a shortcut added by the test seam appears on the sheet.
- New screenshot artifacts `settings.png` and `cheat-sheet.png`, added to the AGENTS.md list in this PR.

### Done when

The two "lands at M4" stubs are gone, every listed setting persists across relaunch, the palette inventory
covers the new commands, and the cheat sheet needs no source edit to stay current.

---

## T33: remote-image control

**Status: planned.**

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

**Status: planned.**

**Depends on:** T32 (manager pane) · **Unblocks:** nothing · **Spec:** F8

### Why

F8 in full: named reusable text blocks, inserted by palette or a `;trigger` typed inline, with an optional
subject and a `{cursor}` marker. This is the feature the Lexical decision was made for (M2-PLAN, editor
decision): expansion must be a single undoable step with correct caret placement, which needs a real
document model.

### Design (decided)

- **Schema bump to 22.** New `snippets` table; the same bump drops `outbox.remote_updated_at`, which is
  written and never read (KNOWN-ISSUES REF-5 says to fold the drop into the next bump). The table is
  additive and rides the AGENTS.md manual dogfood procedure. The drop is not additive, so it does not:
  AGENTS.md routes destructive changes through an explicit task-level migration design, and this paragraph
  is that design. The column has no reader, so the drop deletes nothing any code path uses; the operator
  still takes the procedure's backup first, runs its before/after checks, and applies everything with the
  version stamp in one transaction. Dogfood DDL:

  ```sql
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
  PRAGMA user_version = 22;
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

**Status: planned.**

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
  follows the AGENTS.md manual procedure. Dogfood DDL, in one transaction, uses version 23 after T34's 22;
  swap the numbers if T35 lands first:

  ```sql
  BEGIN IMMEDIATE;
  ALTER TABLE outbox ADD COLUMN follow_up_at INTEGER;
  ALTER TABLE reminders ADD COLUMN origin_message_id TEXT;
  ALTER TABLE reminders ADD COLUMN origin_rfc_message_id TEXT;
  ALTER TABLE reminders ADD COLUMN origin_internal_date INTEGER;
  PRAGMA user_version = 23;
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

---

## T36: AI drafting foundation

**Status: planned.**

**Depends on:** T32 (enable pane) · **Unblocks:** T37 · **Spec:** F17, D2, §6

### Why

F17 is opt-in, bring-your-own-key AI reply drafting. This task builds everything except the composer
experience: the provider client, key custody, the enable screen, and the test seam T37's e2e needs. The
split keeps each PR reviewable and puts the security-sensitive half (keys, network, guardrails) in its own
diff.

### Design (decided)

- **The LLM client lives in the main process** (`src/main/ai/`). D2 says requests go directly from the
  client to the chosen provider, and the renderer-sandbox invariant means the renderer is not that client.
  Main is the right process rather than the utility: the key comes from `safeStorage`, which is main-only,
  and no SQLite access is needed. Streaming crosses to the renderer as typed IPC events
  (`ai:generate` → chunk events → done/error, plus `ai:cancel`), following the acknowledged-toast pattern
  from T18.
- **Keys live in `safeStorage`, never in SQLite.** The `settings` table is plaintext. The key is stored
  beside the OAuth tokens' pattern, and removing it in the UI deletes it from the OS keychain (F17
  guardrail).
- **Two wire protocols, one interface:** the Anthropic Messages API and OpenAI-compatible chat completions
  (which covers Ollama and LM Studio for local models). Provider, base URL (for compatible endpoints), and
  model are user-selectable with a sensible default per provider, recorded in code.
- **The enable screen states what leaves the machine** and when, verbatim per F17: the current thread, the
  voice profile, and any selected style examples, sent to the chosen provider only when a draft is
  requested. Enabling requires a key. Disabling stops all LLM traffic.
- **Voice profile** (tone preset plus free-text standing rules, and the voice-matching toggle) stores in
  the `settings` table. It contains no mail content, so plaintext storage is fine. F18 scopes the provider
  key, model choice, and voice profile app-global (rule 9): one configuration serves every signed-in
  account. Style examples are the exception, drawn per draft from the owning account's sent mail (T37).
- **Test seam:** `attn:test:installFakeAiProvider` in `src/main/testIpc.ts`, disabled outside the env seam
  like every other seam. It scripts streamed chunks, records every request payload, and is the only way e2e
  ever exercises F17. Real endpoints stay out of e2e, mirroring the Gmail rule.

### Testing

- Unit: request shaping for both protocols (system prompt, thread content, voice rules, style examples,
  model); key round-trip and deletion against a fake `safeStorage`; disabled state short-circuits before
  any network object is constructed.
- E2e: enable flow through the settings pane with the fake provider; disable and assert the seam records
  zero requests when T37's command is invoked (this assertion lands here as a placeholder command and is
  strengthened in T37).

### Done when

A key can be added, used by a scripted generation round-trip in tests, and removed; the enable screen shows
the disclosure text; with the feature off, no code path reaches a provider.

---

## T37: AI drafting in the composer

**Status: planned.**

**Depends on:** T36 · **Unblocks:** nothing · **Spec:** F17, §5

### Why

The user-facing half of F17: generate a reply into the composer as a fully editable draft, refine it with a
one-line instruction, and never auto-send.

### Design (decided)

- **Shortcut decided: `Mod+J`**, command name `Draft AI reply`. Nothing in §5 or the registry uses it, and
  the palette inventory test will catch a future collision. This PR records the assignment in SPEC §5 and
  F17 (the spec explicitly left it to M4).
- **Where it works:** in the reader and in an open inline reply composer. Invoked from the reader with no
  composer open, it opens the inline reply composer first, then streams into it. It is unavailable in a
  new-message composer in v1; F17 scopes drafting to replying to an open thread.
- **Streaming is editable and one undo step.** Chunks append into Lexical as normal editable content, with
  history coalesced so a single `Mod+Z` removes the whole draft (F17: insertion is undoable like any other
  edit). The insert passes the composer sanitize path (rule 3).
- **`Esc` cancels cleanly:** it aborts the stream via `ai:cancel` and keeps the text already inserted,
  still as one undoable step. A second `Esc` behaves like any composer `Esc`.
- **Inline refine:** after a draft lands, a one-line instruction field ("shorter", "more formal")
  regenerates. The regeneration replaces the prior AI-inserted region as a single undoable step; text the
  user edited by hand is theirs, so refine is offered only while the AI region is unedited.
- **Voice matching:** when the toggle is on, a handful of the user's recent sent replies are selected
  locally from the store of the account that owns the draft (F18: replies bind to the thread's owning
  account) and sent as style examples. When it is off, no sent-mail content may appear in the
  request; the seam's recorded payloads are the proof.
- **Never auto-sends.** Output lands behind the normal send flow, undo send included. Generation must not
  block the UI (F17 acceptance), and it yields to interactive work (rule 7).

### Testing

- E2e with the fake provider: `Mod+J` in the reader opens the reply composer and streams the scripted
  draft; the result is editable and sends through the normal outbox; one `Mod+Z` removes it; `Esc`
  mid-stream stops cleanly with partial text present; refine replaces the draft; with voice matching off,
  no recorded payload contains sent-mail content; with the feature disabled, `Mod+J` shows the disabled
  hint and the seam records zero requests.
- Unit: sent-reply selection for style examples (recency, own-reply filter, count cap).
- New screenshot artifact `ai-draft.png`, added to the AGENTS.md list.

### Done when

F17's acceptance criteria hold end to end under the seam: zero traffic when disabled, `Esc` cancels
cleanly, voice-matching-off sends no sent-mail content, and insertion is one undo step.

---

## T38: Windows numeric badge overlay

**Status: planned.**

**Depends on:** nothing · **Unblocks:** nothing · **Spec:** F12

### Why

M1 shipped the Windows badge as a static dot with the count in its tooltip and recorded the rendered
numeric overlay as M4 packaging polish (M1-PLAN accepted deviations). This is that task.

### Design (decided)

- A pure function renders the count into an overlay bitmap (nativeImage): centered numerals, `99+` cap,
  legible at 16px. The existing badge update path in `notify.ts`/`index.ts` swaps the static dot for the
  rendered image; the tooltip keeps the exact count. macOS `setBadgeCount` is untouched.
- The count itself is not this task's business: M5's A2 already sums it across signed-in accounts
  (F12/F18). T38 changes only how Windows renders the number it is handed.

### Testing

- Unit: the bitmap generator is pure and platform-independent; assert dimensions, the `99+` cap, and that
  0 clears the overlay. These run on any OS.
- The e2e suite runs on macOS and cannot see a Windows overlay. Manual evidence on a Windows machine
  (counts 1, 42, 150, then 0) is recorded in T40's exit checklist, following the T20-EVIDENCE convention.

### Done when

The unit matrix is green and the Windows manual check is ticked in the T40 checklist.

---

## T39: auto-update, signing, and notarization

**Status: planned.**

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
- **Automatic updates never cross a schema version.** `openDatabase` rejects a different nonzero
  `user_version`; downloading a new binary is not a database upgrade. Publish separate feeds for each
  `CURRENT_SCHEMA_VERSION` and include the required schema version in update metadata. Before download
  and again before installation, require an exact match among the running build, the local database,
  and the target release. Missing or mismatched metadata rejects the update, including cached downloads.
  The release verifier checks that feed metadata agrees with the packaged schema, so a schema-changing
  artifact cannot enter the prior schema's feed. Existing installations stay on their compatible feed.
  Moving to a new schema requires a separate, explicit upgrade procedure with backup and data-preservation
  checks; it never deletes the profile, tokens, drafts, queued sends, or reminders automatically. This
  task does not add a runtime migration framework.
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

**Status: planned.**

**Depends on:** every task above · **Unblocks:** the v1 tag

### Why

M4 is the last milestone, so its exit list is also v1's. Earlier milestones left manual items open on
purpose (real-OS and real-Gmail checks that the harness cannot run); they come due here, once, together.

### The exit checklist

Feature evidence (this milestone):

- [ ] Real-Gmail follow-up run: send with a 3-day follow-up from a dogfood profile, reply from another
      account, confirm cancellation; let a second one expire and confirm resurfacing. Confirm the sent
      message's own history event does not cancel either reminder, and exercise a coexisting snooze.
- [ ] AI drafting against one real provider (any, including a local Ollama): enable, draft, refine, send,
      disable, and confirm zero traffic after disable (proxy or provider dashboard).
- [ ] Windows numeric badge manual check (from T38).
- [ ] Signed/notarized install and same-schema update of a populated profile on both OSes; incompatible
      or missing schema metadata is rejected without changing the installation or local data (from T39).
- [ ] Credential-free personal packaging on both OSes, with no updater traffic or cached installation.
- [ ] Every new screenshot artifact inspected: `settings.png`, `cheat-sheet.png`,
      `remote-images-blocked.png`, `snippet-manager.png`, `ai-draft.png`.

Inherited manual items (owed by earlier milestones, still open as of 2026-08-30; verify against their plan
docs and tick or strike with evidence):

- [ ] M1's real-OS notification click-through smoke (M1-PLAN exit checklist).
- [ ] M2's real-Gmail bootstrap, exactly-once, and hydration observations (M2-PLAN T20).
- [ ] M2's one-week sole-client dogfood run, extended to exercise snippets, follow-ups, and AI drafting.
- [ ] M5 (multi-account) has exited per M5-PLAN, including its A7 isolation audit. SPEC §8: v1 does not
      ship before both milestones exit.

Bookkeeping:

- [ ] SPEC §8 status paragraph updated; the M4 bullet marked done.
- [ ] KNOWN-ISSUES re-verified: every entry either still true (re-stamp) or removed by a named PR.
- [ ] The perf suite is green on the release build; §7 budgets hold with all M4 features enabled.

### Done when

Every box is ticked or explicitly struck with a recorded reason, and the v1 tag is cut from a green
`npm run verify` on `main`.

---

## Out of scope for M4

Multi-account is no longer post-v1, but it is not M4 either: it is M5 (F18, §9 #21), planned separately.
The v1.1 items stay v1.1: the global-hotkey quick panel and custom themes. Send later stays v1.5 (F7, the
companion Apps Script). Google OAuth verification stays deferred (decision #2). Read statuses
stay v2 (D2). Full keyboard remapping stays post-v1. AI beyond reply drafting (summaries, auto-triage,
semantic search) stays v2+; T36's provider client is not an invitation to add background AI features, which
F17 forbids regardless.

## Open questions

| Question | Why it matters | Decide by |
|---|---|---|
| Public release repo or private-feed workaround for auto-update? | Gates T39's feed wiring | Before T39's updater lands; record in T39 |
| Default model per provider | Users see it on the enable screen | T36 review; record in code and F17 if the spec should name it |
| The M3 pathological-mailbox posture question (M3-PLAN) is still open | §7 budgets vs. lifetime headers | Unchanged; not an M4 gate |
