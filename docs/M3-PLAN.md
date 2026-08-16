# M3 Implementation Plan — Find & Focus (opening block: the sync restructure)

**Audience:** the engineer(s) building M3. Same contract as [M1-PLAN.md](M1-PLAN.md) and [M2-PLAN.md](M2-PLAN.md): every task is one PR, nothing is done until `npm run verify` is green, and "spec F2" means a section of [SPEC.md](SPEC.md) (v0.15) — read it before starting the task.
**Basis:** SPEC §8 M3, §9 #10 (system mailboxes are explicit v1 scope), §9 #17 (lifetime headers replace the 12-month window), §6 (utility-process move), F2 (sync engine), F3 (mailbox navigation), F10 (instant search).
**Goal:** M3 makes everything in the account *findable* — locally, instantly, and without a window cliff. That requires the store to hold the mail first, which is why this milestone opens with sync work rather than with search UI.

**Status:** this document currently plans **only M3's opening sync block (S1–S4)**. The feature tasks that follow it — FTS5 search, mailbox navigation, splits, inbox-zero states, themes, palette hardening — are listed at the end as scope but are **not yet planned**; they get written up when S1–S4 are underway and the store's shape is settled.

---

## Why M3 opens with sync

M2 leaves the local store holding Inbox (12 months of metadata, 90 days of bodies), Sent metadata, drafts, and — once T13A lands — a lifetime header sweep of everything Gmail returns from an unfiltered listing. Three gaps remain, and every one of them is a *data* gap that a UI task cannot close:

1. **Spam and Trash are never fetched.** `threads.list` excludes both unless explicitly asked (SPEC §9 #17), so M3's Spam and Trash mailboxes would render empty against a store that never had the rows.
2. **The 12-month tier is still Inbox-scoped at normal priority.** T13A's sweep does reach archived mail, but it is deliberately throttled and low-priority; a first-run user should not wait on a lifetime sweep to search last quarter's archived mail.
3. **Reconciliation and expiry recovery only understand INBOX.** `reconcileInboxMembership` (`src/main/sync/poller.ts:77`) is hardcoded to one label, and `SyncController.recoverExpiredHistory` re-lists INBOX alone. Once Spam and Trash are cached, that is not merely incomplete — it is actively wrong, because Gmail auto-purges both at ~30 days and nothing would ever remove the local rows.

Building the search and mailbox UI on top of that store would mean shipping views that are quietly missing mail, then fixing sync underneath them. Reverse the order.

```mermaid
graph LR
  S1[S1 utility process for sync]
  S2[S2 per-message label storage]
  S3[S3 all-mail + spam/trash stages]
  S4[S4 generalized reconcile + expiry recovery]
  F[Feature tasks: search, mailboxes, splits, themes, palette]

  S1 --> S3
  S2 --> S3
  S3 --> S4
  S4 --> F
  S2 --> F
```

Parallelization: S1 and S2 are independent of each other and can run side by side. S3 wants both landed first — S1 so the stage rewrite happens in its final home, S2 so the new rows are stored with honest per-message labels from the first fetch rather than being backfilled into correctness later.

---

## Global rules (carried from M2, still binding)

1. **No runtime compatibility-migration framework.** `src/main/db/schema.ts` is the single authoritative snapshot and every schema change bumps `CURRENT_SCHEMA_VERSION` (currently 11). Throwaway profiles may be deleted and re-synced; a real dogfood profile gets the additive manual upgrade in `AGENTS.md`, and **every schema-changing task publishes its exact DDL**.
2. **IPC has three parts** (main handler, preload bridge, typed channel map in `src/shared/`) — all in the same commit.
3. **Mail content is untrusted**, incoming and outgoing alike.
4. **Select on `data-testid`** in e2e.
5. **Every user-facing action is a registered command** (F5) — and in M3 the palette test asserts the full inventory, so this stops being an honor system.
6. **One reducer, two sources.** Server history events and local optimistic actions keep flowing through the same state-transition code. S1 moves that code between processes; it does not fork it.
7. **Interactive work outranks historical indexing** (SPEC §6). Any new background sweep yields to sends, action replay, history polling, and body hydration.
8. **If your task changes the verify pipeline or harness behavior, update AGENTS.md in the same PR.**

---

## S1 — Move sync work into an Electron utility process

**Depends on:** nothing (M2 deliberately deferred this — see M2-PLAN's risk register) · **Unblocks:** S3 · **Parallel with:** S2 · **Spec:** §6 architecture

### Why first

SPEC §6 already commits M3 to moving Gmail fetch, backfill, derived-data rebuilds, and FTS indexing into a utility process, with the main process remaining the typed IPC/lifecycle broker. M2's risk register deferred it with the reasoning "don't move the process boundary under the outbox build" — the same reasoning applies in reverse now: do the move while the stage set is stable and well-tested, then restructure stages inside the new home. Doing S3 first would mean writing the new stages twice, or moving a boundary under freshly-changed code.

### Design constraints (not a full design — that is this task's first deliverable)

- **Behavior-preserving.** This task moves code; it does not change what sync fetches. The e2e suite and the sync unit tests are the contract, and they should pass unchanged apart from wiring.
- **Preserve the two invariants that M2 paid for:** one reducer for server- and locally-originated changes, and exactly-once send. Neither may acquire a second implementation on the other side of the process boundary.
- **Durable checkpoints survive a crash of the utility process**, and the supervisor restarts it without restarting the app or losing the action queue.
- **The SQLite connection must have exactly one owner.** Decide explicitly — either the utility process owns the DB and the main process asks it for reads, or the DB stays in main and the utility process ships parsed results back. Do not end up with two writers; the current `Db` handle is passed directly into queries, IPC handlers, and executors, so this decision reaches most of `src/main/`.
- **`SchedulerTime` injection stays** (`src/main/time.ts`) so tests never wait on wall-clock time.

### Testing and done condition

Existing unit + e2e coverage passes with the boundary moved; add a supervisor test that kills the utility process mid-backfill and asserts the next cycle resumes from the persisted cursor with no duplicate rows. Done when sync runs off the main thread, interaction budgets in §7 are unchanged or better, and no invariant has a second implementation.

---

## S2 — Per-message label storage

**Depends on:** nothing · **Unblocks:** S3, and every mailbox view · **Parallel with:** S1 · **Spec:** §9 #17, F3

### Why

`persistThread` (`src/main/sync/persist.ts`) collects `labelUnion` across a thread's messages and writes it to `thread_labels`; `messages` has no label column at all. A thread-level union cannot express a partially-trashed or partially-spammed thread, which is exactly what Gmail produces — deleting one message from a live conversation is ordinary behavior. Once Trash and Spam are cached (S3), that union would put a live thread in the Trash view and hide it from All Mail. Gmail's own semantics are per-message, so the store has to be too.

The same column fixes a second known wrinkle: a Gmail-side reply draft arriving on an existing thread through the history path is persisted as an ordinary message, so the reader can render an in-progress draft as if it were sent mail. With per-message labels, `DRAFT` is visible to the query layer and the reader can exclude it.

### Design and implementation

- Add `labels_json TEXT` to `messages`, written from `msg.labelIds` in the same loop that builds `labelUnion`. Keep `thread_labels` as the thread-level projection — mailbox list queries stay fast against it — but let per-message queries (conversation rendering, Trash/Spam membership, draft exclusion) read the new column.
- **Metadata-only refetches must not clobber it.** `persistThread`'s upsert already guards `attachments_json` behind `@metadata_only`; label ids *are* present on metadata-format fetches, so `labels_json` can be written unconditionally — assert that in a test rather than assuming it.
- Decide and document the view rules that follow Gmail's own semantics: **Trash and Spam list any thread with at least one message carrying that label** — a single deleted message must be findable in Trash even though its conversation lives on — while **All Mail lists any thread with at least one message outside SPAM/TRASH**. A mixed thread therefore appears in both, and each view renders the mailbox-appropriate message subset: normal reading contexts exclude trashed/spammed messages, the Trash/Spam reader surfaces them. Encode membership in one query helper, not per call site.
- Update the reader to exclude `DRAFT`-labeled messages from the conversation body, deferring to M2's composer for those.
- **Schema:** bump `CURRENT_SCHEMA_VERSION`. Local dogfood DDL: `ALTER TABLE messages ADD COLUMN labels_json TEXT;` plus the `PRAGMA user_version` bump in the same `BEGIN IMMEDIATE … COMMIT`. Existing rows read as `NULL` and are repopulated by ordinary refetches; note in the PR that a mixed-label thread stays thread-level-only until its next fetch.

### Testing and done condition

Unit: the persist path stores per-message labels from both `full` and `metadata` fetches; the any-message membership rule for Trash/Spam and the outside-SPAM/TRASH rule for All Mail; draft exclusion. E2e: a seeded fixture thread with one TRASH message appears in both the All Mail and Trash membership queries, and normal reading contexts render its conversation without the trashed message. Done when a partially-trashed thread is discoverable in Trash *and* alive in All Mail, and the reader never shows a draft as sent mail.

---

## S3 — All-mail and Spam/Trash backfill stages

**Depends on:** S1, S2 · **Unblocks:** S4, mailbox views, search recall · **Spec:** F2 backfill stages 4–5, §9 #17

### Why

This is the task the sync redesign exists for. Today's stages are Inbox-scoped plus a Sent pass; SPEC F2 replaces that with a priority-ordered walk whose 12-month tier has **no label filter**, followed by explicit Spam and Trash passes. After this task, everything Gmail holds for the last year is local at normal background priority, and T13A's lifetime sweep becomes the tail rather than the only path to archived mail.

### Target stage order (SPEC F2)

```
inbox       12m, INBOX          headers   triage surface + unread count complete first
bodies      90d, INBOX          full      recent mail readable offline
drafts      all drafts          full      shipped in T14D
all-mail    12m, no filter      headers   ← new; subsumes the current `sent` stage
spam-trash  all (~30d exists)   headers   ← new; explicit label listings
reconcile   per-label id sweeps           ← generalized in S4
lifetime    no date bound       headers   T13A's throttled sweep
```

### Design and implementation

- **Provider gains spam/trash reach.** `ListThreadIdsOptions` (`src/main/sync/provider.ts`) grows the knob and `GmailMailProvider.listThreadIds` passes it. Prefer **explicit `labelIds: ['SPAM']` / `['TRASH']` stages over a global `includeSpamTrash=true`**: it keeps junk from interleaving into the 12-month walk, keeps the ordering legible in the footer, and keeps the lifetime sweep correct without a flag (Gmail purges both at ~30 days, so there is no lifetime spam/trash to reach).
- **Skip-if-present is what makes overlapping stages cheap.** Before fetching a listed thread id, skip it when `threads` already holds it. Put the check in the stage runner, not in `persistThread` — the write path stays authoritative for threads that *are* fetched. This is safe because the history checkpoint is recorded before the first backfill page, so anything already stored is kept current by the poller.
- **Overlap, never complement.** The all-mail stage queries `newer_than:12m` and re-lists what the inbox stage already covered. Do **not** try to carve exact date complements: Gmail's `newer_than`/`older_than` operators are coarse and fuzzy, and a seam gap loses mail invisibly, while re-listing ids costs ~1% of the fetch budget.
- **The `sent` stage is removed, not kept.** SENT is inside the unfiltered scope, so the dedicated pass is redundant once all-mail runs. Delete the stage, its cursor token, and its status label in the same PR; T13A's contact derivation is unaffected because it reads the same stored messages. Note the interaction: a profile that resumes mid-`sent` on the old cursor grammar must route to a valid new phase rather than throwing in `parseCursor`.
- **Cursor grammar and stage plumbing.** `parseCursor`/`checkpoint` in `src/main/sync/backfill.ts` gain the new phases with the existing `phase:pageToken` resume semantics; `SyncStage` (`src/shared/mail.ts:96`) gains `'all-mail'` and `'spam-trash'`; `SYNC_STAGES` and `syncStageLabel` (`src/renderer/src/components/SyncStatus.tsx:5`) gain entries ("All mail", "Spam & trash"). The existing `runThreadPhase` handles both new stages as-is — they page thread ids like the others.
- **Skip legacy `CHAT` rows** defensively; old accounts surface Hangouts messages in unfiltered listings.
- **Seeded accounts skip the new stages** exactly as they skip `sent` today (`src/main/index.ts:236`).
- **Contact hygiene is a hard prerequisite, and it belongs to T13A.** If T13A has not landed when this starts, this PR carries the rule instead: messages labeled SPAM or TRASH never contribute to `contact_messages`. A deliberate 30-day spam pass would otherwise bulk-import spammer addresses into autocomplete — a visible regression, not a theoretical one.

### Testing and done condition

Unit: cursor routing and resume across every new phase, including the retired `sent` token; skip-if-present against a seeded store (assert *no* fetch for present ids); the mock provider receives explicit SPAM/TRASH listings and an unfiltered 12-month query; CHAT rows skipped. E2e: a seeded profile reaching the new stages reports them in the footer in order and reaches `done`. Manual signed-in smoke: an account with archived mail from ~6 months ago has those threads locally without opening them, and Trash/Spam rows exist. Done when the last 12 months of the account — archived, sent, spam, and trash — are in the store at normal background priority, and the footer narrates the new stages honestly.

---

## S4 — Generalized reconcile and expiry recovery

**Depends on:** S3 · **Unblocks:** trustworthy mailbox views · **Spec:** F2 incremental, §9 #17

### Why

`reconcileInboxMembership` takes a single server id list and strips INBOX from local threads missing from it; `recoverExpiredHistory` re-lists INBOX alone. That was cheap and sufficient while INBOX was the only cached label. With Spam and Trash local it becomes wrong in a way that grows over time: Gmail purges both at ~30 days, and a `historyId` expiry (any absence longer than roughly a week) leaves ghost rows that no code path ever removes. Label drift on archived and starred threads has the same shape — changes made in Gmail web while the app was away are never corrected.

### Design and implementation

- Generalize to **per-label membership reconciliation**: for each cached system label, page its ids (ids only — ~10 units per page, no per-thread fetch) and apply the same add/remove reducer path, with `replayPendingThreadDeltas` preserving local intent exactly as it does today. One implementation, driven by a list of labels, replaces the hardcoded INBOX call.
- Add a **tombstone pass — and never conclude deletion from system-label absence.** An archived, read, unstarred thread legitimately carries no system label at all, so "absent from every re-listed system label" describes most archived mail; deleting on that signal would destroy valid cached bodies, search results, and contact contributions. Existence has exactly two trustworthy signals: absence from an **unfiltered thread-id listing walked to exhaustion in the same run plus the SPAM and TRASH listings** (the unfiltered walk excludes both), or a per-thread `threads.get` returning 404. Membership reconciliation therefore never deletes; the tombstone pass runs only when a full existence sweep is in hand (expiry recovery, a lifetime re-walk), or it verifies each candidate individually and deletes on 404 alone. Partial pages prove nothing — a network truncation must never delete real mail.
- **Both the backfill's reconcile stage and expiry recovery call the same helper.** Two callers, one behavior.
- Reconcile is inherently a full-listing operation, so keep it bounded: ids only, no bodies, and let the M1 offline/retry routing handle interruption. A long lifetime sweep will very likely span a `historyId` expiry — make that interaction explicit and tested rather than discovered.

### Testing and done condition

Unit: per-label reconcile across add/remove/no-change; the tombstone rule, including its two negative cases — an archived thread with **no** system label survives reconcile untouched, and a truncated listing must **not** delete; pending local deltas replayed on top of server truth. E2e: a seeded store with a thread absent from a re-listed label loses that membership, and one absent from an exhausted existence sweep (or 404ing on direct fetch) is removed. Done when a week offline followed by a relaunch converges every cached label to server truth without ghost rows, archived label-less mail survives, and no local pending action is lost in the process.

---

## Still to be planned (M3 scope, tasks not yet written)

These are the milestone's feature half. They depend on S1–S4 and get planned once the store's shape is settled:

- **F10 — FTS5 instant search + operators**, including the "Search all of Gmail" server row and the on-demand thread fetch it implies (fetch-and-persist an arbitrary thread id — a primitive the app does not have today, useful beyond search).
- **F3 — system mailbox navigation** (Inbox, All Mail, Sent, Drafts, Starred, Snoozed, Spam, Trash) with `G` chords and palette entries; list virtualization stops being conditional at All Mail scale.
- **F11 — split inbox + rules.**
- **Inbox-zero states, F14 themes, and palette hardening** (every command registered and asserted).
- **§9 #14 — the contextual chord guide** in the shortcut footer, deferred from M2.

---

## Open questions for this milestone

| Question | Why it matters | Decide by |
|---|---|---|
| Does the utility process own SQLite, or does main? | Reaches most of `src/main/`; two writers is a corruption bug | S1 design |
| Pathological-mailbox posture — design target (e.g. smooth to 250k messages), then throttle harder, cap, or expose a setting? | §7's budgets are written against 50k messages; lifetime headers can exceed that | S3, informed by T13A's real-mailbox measurement |
| Is the lifetime attachment-flag walk (`q=has:attachment`, ids only) worth its ~1% cost? | Decides whether `has:attachment` is trustworthy locally before mail is hydrated | S3 or T13A, whichever runs second |
