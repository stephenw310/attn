# M3 Implementation Plan: Find and Focus

**Audience:** the engineers building M3. Same contract as [M1-PLAN.md](M1-PLAN.md) and [M2-PLAN.md](M2-PLAN.md).
Every task is one PR, nothing is done until `npm run verify` is green, and "spec F2" means a section of
[SPEC.md](SPEC.md) (v0.15). Read the section before starting the task.

**Basis:** SPEC §8 M3, §9 #10 (system mailboxes are explicit v1 scope), §9 #17 (lifetime headers replace the
12-month window), §6 (utility-process move), F2 (sync engine), F3 (mailbox navigation), F10 (instant search).

**Goal:** M3 makes everything in the account findable, locally, instantly, and without a window cliff. The
store has to hold the mail before the UI can find it, which is why the milestone opens with sync work rather
than with search.

## What is left

S3 and S4's membership half shipped early, inside the T13A sync-stage PR (#51). The owner chose to land the
whole stage pipeline at once rather than split it across milestones. What remains:

| Task | State | Blocks |
|---|---|---|
| S1 utility process | not started | F10's indexing |
| S2 per-message labels | not started | F3 mailbox views, S4's tombstone pass |
| S4 tombstone pass | membership half shipped; existence sweep open | trustworthy mailbox views |
| Feature half | not planned | nothing yet |

S1 and S2 are independent and can run side by side. The feature tasks get written up once the store's shape
is settled.

---

## Where sync stands today

Three mechanisms exist as this milestone begins. Read all three before touching any of them. The most likely
M3 mistake is re-implementing something #51 already shipped.

**1. The staged backfill** (`src/main/sync/backfill.ts`) walks one cursor, `sync_state.backfill_cursor`, with
the grammar `phase`, `phase:pageToken`, or `done`. `SyncStage` in `src/shared/mail.ts` enumerates the phases.

**2. The lifetime sweep** (`src/main/sync/lifetimeSweep.ts`, T13A) is deliberately not a backfill phase. It
holds its own cursor, progress columns, throttle constants, and quota reporting. `startLifetimeSweep` launches
it once the backfill completes. It walks Gmail's default listing newest-first with no query and no label
filter, skipping threads already stored. That shape is correct and M3 does not change it.

**3. The attachment flag walk** (`src/main/sync/attachmentFlags.ts`, #56) runs as the tail of the lifetime
sweep on its own `attachment_cursor`. It is an ids-only `q=has:attachment` listing that raises thread-level
attachment flags, so `has:attachment` is trustworthy before bodies are hydrated.

That is three cursors, not two. Any task that moves or restarts sync has to carry all three.

### The shipped stage pipeline

```
#  stage       scope               fetches   footer label   contacts
1  metadata    12m, INBOX          headers   Message list   senders of received mail
2  bodies      90d, INBOX          full      Recent mail    (same threads, refetched)
3  drafts      all drafts          full      Drafts         none
4  all-mail    12m, no filter      headers   All mail       recipients of sent mail
5  spam        SPAM label          headers   Spam           none, excluded by design
6  trash       TRASH label         headers   Trash          none, excluded by design
7  reconcile   per-label id lists  ids       Finishing up   none
── backfill_cursor ends; sweep_cursor takes over ──
8  lifetime    no date bound       headers   indexing       everything older than 12m
── sweep_cursor ends; attachment_cursor takes over ──
9  attachments has:attachment      ids only  indexing       none
```

Spam and Trash are **two separate stages**, not one combined pass. The retired `sent` stage is gone; old
`sent` cursors route to `all-mail` in `parseCursor`.

### Contracts that still bind

These constrain future work, S1 above all, because S1 moves this code between processes:

1. **The lifetime sweep triggers off the final bounded stage**, not a hardcoded phase name. Adding or
   reordering bounded stages must not strand the sweep.
2. **`SyncStage` has no `lifetime` member.** The sweep and the attachment walk report through their own
   progress channel, which carries `stage: 'lifetime' | 'attachments'`. Duplicating them as backfill phases
   would give them two owners.
3. **Messages labeled SPAM or TRASH never contribute to `contact_messages`.** Without this the 30-day spam
   pass bulk-imports spammer addresses into autocomplete. That is a visible regression, not a theoretical one.
4. **Skip-if-present lives in the stage runner, not in `persistThread`.** The write path stays authoritative
   for threads that are actually fetched.
5. **Stages overlap, they never complement.** The all-mail stage re-lists what the inbox stage covered.
   Gmail's `newer_than` and `older_than` operators are coarse, so a carved date seam loses mail invisibly,
   while re-listing ids costs about 1% of the fetch budget.
6. **Seeded accounts skip the bounded stages.** The check keys off `seedAccountId` in `src/main/index.ts`.

---

## Global rules (carried from M2, still binding)

1. **No runtime compatibility-migration framework.** `src/main/db/schema.ts` is the single authoritative
   snapshot and every schema change bumps `CURRENT_SCHEMA_VERSION`, currently 15. Throwaway profiles may be
   deleted and re-synced. A real dogfood profile gets the additive manual upgrade in `AGENTS.md`, and every
   schema-changing task publishes its exact DDL.
2. **IPC has three parts**: main handler, preload bridge, and the typed channel map in `src/shared/`. All in
   the same commit.
3. **Mail content is untrusted**, incoming and outgoing alike.
4. **Select on `data-testid`** in e2e.
5. **Every user-facing action is a registered command** (F5). In M3 the palette test asserts the full
   inventory, so this stops being an honor system.
6. **One reducer, two sources.** Server history events and local optimistic actions keep flowing through the
   same state-transition code. S1 moves that code between processes. It does not fork it.
7. **Interactive work outranks historical indexing** (SPEC §6). Any new background sweep yields to sends,
   action replay, history polling, and body hydration.
8. **If your task changes the verify pipeline or harness behavior, update AGENTS.md in the same PR.**

---

## S1: move sync work into an Electron utility process

**Depends on:** nothing · **Unblocks:** F10's FTS indexing · **Parallel with:** S2 · **Spec:** §6 architecture

### Why

SPEC §6 commits M3 to running Gmail fetch, backfill, derived-data rebuilds, and FTS indexing in a utility
process, with the main process left as the typed IPC and lifecycle broker.

The original argument for doing S1 first was to avoid writing the new stages twice. That argument expired when
S3 shipped ahead of it in #51. The stage set is now stable and well tested either way, so S1 moves finished
code rather than racing it. What survives is SPEC §6's commitment and the fact that F10's indexing should not
land on the main thread.

### Design constraints

The full design is this task's first deliverable. These bound it:

- **Behavior-preserving.** This task moves code. It does not change what sync fetches. The e2e suite and the
  sync unit tests are the contract, and they should pass unchanged apart from wiring.
- **Preserve the two invariants M2 paid for:** one reducer for server-originated and local changes, and
  exactly-once send. Neither may acquire a second implementation across the process boundary.
- **Durable checkpoints survive a crash of the utility process**, and the supervisor restarts it without
  restarting the app or losing the action queue. All three cursors resume.
- **The SQLite connection has exactly one owner.** Decide explicitly. Either the utility process owns the
  database and the main process asks it for reads, or the database stays in main and the utility process ships
  parsed results back. Two writers is a corruption bug. The current `Db` handle is passed straight into
  queries, IPC handlers, and executors, so this decision reaches most of `src/main/`.
- **`SchedulerTime` injection stays** (`src/main/time.ts`) so tests never wait on wall-clock time.

### Testing and done condition

Existing unit and e2e coverage passes with the boundary moved. Add a supervisor test that kills the utility
process mid-backfill and asserts the next cycle resumes from the persisted cursor with no duplicate rows. Done
when sync runs off the main thread, the §7 interaction budgets are unchanged or better, and no invariant has a
second implementation.

---

## S2: per-message label storage

**Depends on:** nothing · **Unblocks:** F3 mailbox views, S4's tombstone pass · **Parallel with:** S1 ·
**Spec:** §9 #17, F3

### Why

`persistThread` (`src/main/sync/persist.ts`) collects `labelUnion` across a thread's messages and writes it to
`thread_labels`. The `messages` table has no label column at all.

A thread-level union cannot express a partially trashed or partially spammed thread, which is exactly what
Gmail produces. Deleting one message from a live conversation is ordinary behavior. Now that Trash and Spam
are cached, that union puts a live thread in the Trash view and hides it from All Mail. Gmail's semantics are
per-message, so the store has to be too.

A related wrinkle closed in M2 under T14B: `persistThread` drops `DRAFT` and `CHAT` labelled messages at the
top of its loop (`nonDraftMessages`), so a Gmail-side reply draft arriving through the history path is never
stored as an ordinary message. Per-message labels make that decision queryable instead of a write-time filter,
and let a stored message's `TRASH` and `SPAM` membership be read per row.

One edge the filter leaves for this task, carried over from the review's B4 finding: when every message in an
authoritative snapshot is a draft, `persistThread` returns early and never prunes the thread's stale non-draft
rows. A thread whose real messages were permanently deleted while a draft remains keeps them locally until the
S4 tombstone pass. Handle that pruning here, where the message loop is being reworked anyway.

### Design and implementation

- Add `labels_json TEXT` to `messages`, written from `msg.labelIds` in the same loop that builds `labelUnion`.
  Keep `thread_labels` as the thread-level projection so mailbox list queries stay fast, but let per-message
  queries read the new column: conversation rendering, Trash and Spam membership, and draft exclusion.
- **Metadata-only refetches must not clobber it.** `persistThread`'s upsert already guards `attachments_json`
  behind `@metadata_only`. Label ids are present on metadata-format fetches, so `labels_json` can be written
  unconditionally. Assert that in a test rather than assuming it.
- Decide and document the view rules, following Gmail's own semantics. **Trash and Spam list any thread with
  at least one message carrying that label**, so a single deleted message stays findable in Trash even though
  its conversation lives on. **All Mail lists any thread with at least one message outside SPAM and TRASH.** A
  mixed thread therefore appears in both, and each view renders the mailbox-appropriate message subset: normal
  reading contexts exclude trashed and spammed messages, while the Trash and Spam reader surfaces them. Encode
  membership in one query helper, not per call site.
- Keep the reader free of `DRAFT` labelled messages. Today that holds because the write path never stores
  them. Once per-message labels exist, decide whether the filter stays at write time or moves to the query
  layer, and keep the T14B unit test green either way.
- **Schema:** bump `CURRENT_SCHEMA_VERSION`. The local dogfood DDL is
  `ALTER TABLE messages ADD COLUMN labels_json TEXT;` plus the `PRAGMA user_version` bump, both in the same
  `BEGIN IMMEDIATE … COMMIT`. Existing rows read as `NULL` and repopulate through ordinary refetches. Note in
  the PR that a mixed-label thread stays thread-level-only until its next fetch.

### Testing and done condition

Unit: the persist path stores per-message labels from both `full` and `metadata` fetches; the any-message
membership rule for Trash and Spam; the outside-SPAM/TRASH rule for All Mail; draft exclusion. E2e: a seeded
fixture thread with one TRASH message appears in both the All Mail and Trash membership queries, and normal
reading contexts render its conversation without the trashed message. Done when a partially trashed thread is
discoverable in Trash and alive in All Mail, and the reader never shows a draft as sent mail.

---

## S3: all-mail and spam/trash backfill stages

**Shipped in #51**, pulled forward from M3 by owner decision, ahead of S1 and S2. The stage rewrite therefore
landed in the main process and moves with S1 later.

What it delivered: the unfiltered 12-month `all-mail` stage at normal background priority, explicit `spam` and
`trash` label stages, and the retirement of the dedicated `sent` stage. The pipeline and the contracts it
established are recorded under [Where sync stands today](#where-sync-stands-today). Nothing here is open.

Two facts worth keeping, because they explain the shape rather than the implementation:

**Sent mail and the contact index are not stages.** Gmail's unfiltered `threads.list` already returns SENT, so
sent mail rides along with the all-mail walk and, beyond 12 months, the lifetime sweep. That is why the
dedicated `sent` stage was deleted rather than reordered. The contact index is not a fetch at all:
`persistThread` derives it from headers on every message write, recording recipients when a message carries
SENT and the sender otherwise. `METADATA_HEADERS` already requests From, To, Cc, Bcc, and Reply-To, so
header-only stages populate contacts exactly as full fetches do. Autocomplete ramps rather than switching on.

**The sweep overlaps the stages for free.** Stage 4 fetches the year, and the lifetime sweep skips those ids
and continues into older mail. Neither fetches a thread the other already stored.

---

## S4: generalized reconcile and expiry recovery

**Membership half shipped in #51.** `reconcileLabelMembership` (`src/main/sync/poller.ts`) generalizes the
INBOX-only helper, the backfill's reconcile phase re-lists INBOX, SPAM, and TRASH, and
`reconcilePurgeableMembership` verifies Spam and Trash candidates thread by thread, where a refetch persists
truth and only a 404 deletes. Both the backfill completion path and
`SyncController.recoverExpiredHistory` call the same helpers, so there are two callers and one behavior. Keep
it that way.

**Open:** the existence-sweep tombstone pass.

**Depends on:** S2, for per-message TRASH and SPAM truth · **Unblocks:** trustworthy mailbox views ·
**Spec:** F2 incremental, §9 #17

### Why the remaining half is hard

A thread purged server-side while its local labels held neither SPAM nor TRASH is never removed. Gmail
auto-purges Spam and Trash at about 30 days, and a `historyId` expiry, meaning any absence longer than roughly
a week, leaves ghost rows that no code path removes.

**Never conclude deletion from system-label absence.** An archived, read, unstarred thread legitimately
carries no system label at all, so "absent from every re-listed system label" describes most archived mail.
Deleting on that signal would destroy valid cached bodies, search results, and contact contributions.

Existence has exactly two trustworthy signals:

1. Absence from an unfiltered thread-id listing walked to exhaustion **in the same run**, plus the SPAM and
   TRASH listings, since the unfiltered walk excludes both.
2. A per-thread `threads.get` returning 404.

Membership reconciliation therefore never deletes. The tombstone pass runs only when a full existence sweep is
in hand, which expiry recovery or a lifetime re-walk can supply, or it verifies each candidate individually and
deletes on 404 alone. Partial pages prove nothing. A network truncation must never delete real mail.

This is why S4's remaining half waits on S2: without per-message labels it cannot tell a partially trashed
live thread from a purged one.

### Design and implementation

- Keep reconcile bounded: ids only, no bodies, and let the M1 offline and retry routing handle interruption.
- `replayPendingThreadDeltas` preserves local intent on top of server truth. The tombstone pass must keep
  using it, or a queued local action is lost whenever reconcile runs.
- A long lifetime sweep will very likely span a `historyId` expiry. Make that interaction explicit and tested
  rather than discovered.

### Testing and done condition

Unit: the tombstone rule and both its negative cases, an archived thread with no system label surviving
reconcile untouched, and a truncated listing that must not delete; pending local deltas replayed on top of
server truth. E2e: a seeded store where a thread absent from an exhausted existence sweep, or 404ing on direct
fetch, is removed. Done when a week offline followed by a relaunch converges every cached label to server truth
without ghost rows, archived label-less mail survives, and no local pending action is lost.

---

## Still to be planned

These are the milestone's feature half. They get planned once the remaining sync work is underway and the
store's shape is settled.

- **F10, FTS5 instant search and operators**, including the "Search all of Gmail" server row and the
  on-demand thread fetch it implies. Fetching and persisting an arbitrary thread id is a primitive the app
  does not have today, and it is useful beyond search.
- **F3, system mailbox navigation** (Inbox, All Mail, Sent, Drafts, Starred, Snoozed, Spam, Trash) with `G`
  chords and palette entries. List virtualization stops being conditional at All Mail scale.
- **F11, split inbox and rules.**
- **Inbox-zero states, F14 themes, and palette hardening**, with every command registered and asserted.
- **§9 #14, the contextual chord guide** in the shortcut footer, deferred from M2.
- **§5 reader keys `N`, `P`, and `O`.** Decided 2026-08-17: bind them, do not cut them (SPEC §9 #18d). They
  land with palette hardening's registry-completeness assertion.

---

## Open questions

| Question | Why it matters | Decide by |
|---|---|---|
| Does the utility process own SQLite, or does main? | Reaches most of `src/main/`; two writers is a corruption bug | S1 design |
| Pathological-mailbox posture: pick a design target such as smooth to 250k messages, then throttle harder, cap, or expose a setting? | §7's budgets are written against 50k messages, and lifetime headers can exceed that | E7's real-mailbox capture in [T20-EVIDENCE.md](T20-EVIDENCE.md) |
| Does S1 run before or after the M2 dogfood week, and does S1 or S2 go first? | S1 moves the process boundary across most of `src/main/`, which is disruptive under a daily driver; S2 bumps the schema, which costs a manual DDL on the dogfood profile | Before either task starts |

Open defects and coverage gaps live in [KNOWN-ISSUES.md](KNOWN-ISSUES.md). Manual sign-off evidence is ticked
in [T20-EVIDENCE.md](T20-EVIDENCE.md).
