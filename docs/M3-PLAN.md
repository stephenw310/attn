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

S3 and S4's membership half shipped early, inside the T13A sync-stage PR (#51). S2, S1, and S4's
tombstone pass followed on 2026-08-22. The sync restructure is complete. What remains is the feature half:

| Task | State | Blocks |
|---|---|---|
| S1 utility process | **done** | F10's indexing |
| S2 per-message labels | **done**, completed 2026-08-22 | nothing; F3 and S4 are unblocked |
| S3 all-mail and spam/trash stages | **done**, shipped in #51 | nothing, it is finished |
| S4 reconcile and expiry recovery | **done**, completed 2026-08-22 | trustworthy mailbox views |
| T22 mailbox navigation (F3) | **planned**, not started | T27, T24's `in:` operator |
| T23 FTS5 index (F10) | **planned**, not started | T24, T25 |
| T24 search UI and operators (F10) | **planned**, not started | T25 |
| T25 on-demand fetch and server search (F10) | **planned**, not started | nothing |
| T26 palette and registry completeness (F5) | **planned**, not started | milestone exit |
| T27 splits and per-split notifications (F11, F12) | **planned**, not started | T28, T29 |
| T28 contextual chord guide (§9 #14) | **planned**, not started | nothing |
| T29 inbox zero (F13) | **planned**, not started | nothing |
| T30 built-in themes (F14) | **done**, completed 2026-08-23 | nothing |

S2 settled the store shape needed for F3 mailbox views and S4, S1 moved that store into the utility process,
and S4 closed the last sync correctness gap. The feature tasks are written up below, under
[The feature half](#the-feature-half-order-and-open-assumptions), which also records the two assumptions
they rest on.

Every task section below opens with the same **Status** line, so you never have to infer state from whether a
section looks long.

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
   snapshot and every schema change bumps `CURRENT_SCHEMA_VERSION`, currently 17. Throwaway profiles may be
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

**Status: done.** The boundary design is recorded in [S1-DESIGN.md](S1-DESIGN.md).

**Depends on:** nothing · **Unblocks:** F10's FTS indexing · **Spec:** §6 architecture

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
- **The utility process owns the SQLite connection.** Decided by the owner on 2026-08-22, recorded in SPEC §9
  #19. It holds the only handle and is the only writer. The main process asks it for reads. Two writers is a
  corruption bug, so there is no fallback path where main writes "just this once".

  This is the expensive half of S1, so scope it before starting. The main process runs raw SQL at **81 sites
  across 20 files** today. They split three ways, and each group needs its own answer in the design:

  1. **Moves wholesale.** `sync/` (`backfill`, `bodies`, `lifetimeSweep`, `persist`, `poller`,
     `attachmentFlags`) and `store/mutate.ts`. This code is the reason for the move.
  2. **Becomes a request across the boundary.** `db/queries.ts` serves every renderer read. Those now travel
     renderer to main to utility and back, so the §7 budgets have to be re-proved rather than assumed. A
     conversation open at 50 ms is the tightest of them.
  3. **Needs an explicit home.** `outbox/` and `actions/executor.ts` write on the user's behalf and carry the
     exactly-once invariant. Putting them behind an IPC hop introduces a failure mode M2 does not have, where
     the caller cannot tell a lost reply from a lost write. Decide where they live and prove the invariant
     holds there before moving anything else.
- **`SchedulerTime` injection stays** (`src/main/time.ts`) so tests never wait on wall-clock time.

### Testing and done condition

Existing unit and e2e coverage passes with the boundary moved. Add a supervisor test that kills the utility
process mid-backfill and asserts the next cycle resumes from the persisted cursor with no duplicate rows. Done
when sync runs off the main thread, the §7 interaction budgets are unchanged or better, and no invariant has a
second implementation.

**Shipped shape:** `ServiceSupervisor` owns the Electron utility lifecycle and typed request protocol. The
utility runtime owns SQLite, sync, action replay, snooze scheduling, draft mirroring, outbox sending, local
reads, and seeded test mutations. Main retains OAuth/keychain access and native effects. The crash e2e kills
the utility during a lifetime page walk, waits for the supervisor restart, resumes from `sweep_cursor`, and
asserts one thread and message row per fixture. The 10,000-thread profile kept cached conversation open at
5 ms p95, local mail refresh at 37 ms p95, and application-owned steady-state memory at 130 MB.

---

## S2: per-message label storage

**Status: done, completed 2026-08-22.**

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

### What shipped

- `messages.labels_json` stores every authoritative message's label ids. Full and metadata fetches both update
  it, while metadata fetches continue to preserve the stored attachment projection.
- `listMailboxThreadIds` owns the per-message membership rules. Trash and Spam include a thread when any
  message has the matching label. All Mail includes it when any message is outside Spam and Trash. Normal and
  All Mail readers hide junk messages; Spam and Trash readers show only their matching messages. Draft and
  legacy Chat rows stay hidden in every reader.
- Optimistic thread deltas update both `thread_labels` and known message label arrays. Pending actions replay
  through that same path after a server snapshot, so the list and reader agree before Gmail confirms a change.
- Normal thread summaries use the newest non-junk message and derive unread, starred, and attachment flags from
  messages that reader can show. Junk-only threads retain a useful summary for their own mailbox; Spam and
  Trash membership sorts mixed threads by their newest matching message rather than this normal summary.
- The write-time draft filter remains. An authoritative snapshot containing only drafts or Chat rows now
  deletes stale ordinary thread data, closing review finding B4.
- Existing `NULL` message labels use thread-level membership until an ordinary refetch fills them. The normal
  reader preserves pre-S2 behavior and shows those legacy rows because the thread union cannot identify which
  row carries junk; matching Spam and Trash readers show the whole legacy thread for the same reason.

The schema is version 16. A stopped local dogfood profile can use this exact additive DDL through the manual
procedure in `AGENTS.md`:

```sql
BEGIN IMMEDIATE;
ALTER TABLE messages ADD COLUMN labels_json TEXT;
PRAGMA user_version = 16;
COMMIT;
```

### Testing and done condition

Unit coverage proves full and metadata persistence, optimistic replay, indexed sparse-mailbox membership, the
three mailbox rules, reader subsets, legacy `NULL` fallback, junk-free normal summaries, draft exclusion, and
draft-only pruning. A seeded Electron test keeps one partially trashed thread in both All Mail and Trash while
the normal list and reader summarize and show only its live messages.

---

## S3: all-mail and spam/trash backfill stages

**Status: done. Shipped in #51. Nothing in this section is work.**

It was pulled forward from M3 by owner decision, ahead of S1 and S2, so the stage rewrite landed in the main
process and moves with S1 later. The section is kept because it explains why the pipeline has the shape S1 is
about to relocate.

It delivered the unfiltered 12-month `all-mail` stage at normal background priority, explicit `spam` and
`trash` label stages, and the retirement of the dedicated `sent` stage. The pipeline and the contracts it
established are recorded under [Where sync stands today](#where-sync-stands-today).

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

**Status: done, completed 2026-08-22.** The membership half shipped in #51; the tombstone pass followed after
S2 and S1.

The shipped half: `reconcileLabelMembership` (`src/main/sync/poller.ts`) generalizes the
INBOX-only helper, the backfill's reconcile phase re-lists INBOX, SPAM, and TRASH, and
`reconcilePurgeableMembership` verifies Spam and Trash candidates thread by thread, where a refetch persists
truth and only a 404 deletes. Both the backfill completion path and
`SyncController.recoverExpiredHistory` call the same helpers, so there are two callers and one behavior. Keep
it that way.

**Depends on:** S2, now complete · **Unblocks:** trustworthy mailbox views ·
**Spec:** F2 incremental, §9 #17

### Why the remaining half is hard

A thread purged server-side while its local labels held neither SPAM nor TRASH is never removed. Gmail
auto-purges Spam and Trash at about 30 days, and a `historyId` expiry, meaning any absence longer than roughly
a week, leaves ghost rows that no code path removes.

**Never conclude deletion from system-label absence.** An archived, read, unstarred thread legitimately
carries no system label at all, so "absent from every re-listed system label" describes most archived mail.
Deleting on that signal would destroy valid cached bodies, search results, and contact contributions.

Existence reconciliation uses two layers of evidence:

1. Absence from an unfiltered thread-id listing walked to exhaustion, plus the SPAM and TRASH listings, makes
   a local snapshot row a deletion candidate. Listing scopes run sequentially, so absence alone does not prove
   deletion when a thread moves between scopes during the walk.
2. A per-thread `threads.get` returning 404 authorizes deletion. A live result removes that row from the
   candidate set.

Membership reconciliation therefore never deletes. The tombstone pass waits for a completed existence sweep,
then verifies every candidate individually and deletes on 404 alone. Partial pages prove nothing. A network
truncation or scope transition must never delete real mail.

S2 now provides the per-message truth S4 needs to distinguish a partially trashed live thread from a purged
one.

### What shipped

- `reconcileThreadExistence` runs first during expired-history recovery, before the replacement history
  checkpoint is recorded. It walks Gmail's unfiltered, Spam, and Trash thread-id listings to exhaustion at
  background priority.
- Each run snapshots the local thread ids into durable SQLite evidence before listing. Threads persisted while
  the scan is running are outside that snapshot and cannot be deleted by it.
- Every page commits its ids and next-page cursor in one transaction. An interrupted listing or authentication
  change retains that progress and deletes nothing. The next attempt resumes the same complete-account walk.
  Only a 400 or 404 diagnostic that names the page token resets a saved cursor; other request errors retain it.
- Every snapshot id absent from the completed union receives a direct metadata fetch. A 404 becomes durable
  deletion evidence, while a live result marks the row present and lets recovery continue without another
  listing walk. Interrupted verification resumes from the first candidate without durable 404 evidence.
- Once verification finishes, the worker deletes only snapshot ids with direct 404 evidence. It removes stale
  reminders with each thread but leaves `action_queue` rows intact.
- A concurrent lifetime header walk yields while expiry recovery owns foreground sync. It resumes from its
  independent durable cursor after the tombstone pass, with no second lifetime owner or cursor reset.
- Membership reconciliation still calls `replayPendingThreadDeltas`, and tombstoning leaves `action_queue`
  rows intact. Server truth wins without silently discarding a user's queued action.
- The test-only seam `attn:test:runExistenceSweep` drives the pass through main, the utility
  process, and the real seeded SQLite store without contacting Gmail.

The schema is version 17. A stopped local dogfood profile can use this exact additive DDL through the manual
procedure in `AGENTS.md`:

```sql
BEGIN IMMEDIATE;
CREATE TABLE thread_existence_state (
  account_id TEXT PRIMARY KEY,
  phase      TEXT NOT NULL,
  page_token TEXT
);
CREATE TABLE thread_existence_evidence (
  account_id       TEXT NOT NULL,
  thread_id        TEXT NOT NULL,
  was_local        INTEGER NOT NULL DEFAULT 0,
  remote_seen      INTEGER NOT NULL DEFAULT 0,
  verified_missing INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, thread_id)
);
CREATE INDEX idx_thread_existence_candidates ON thread_existence_evidence (
  account_id,
  was_local,
  remote_seen,
  verified_missing
);
PRAGMA user_version = 17;
COMMIT;
```

### Testing and done condition

Unit coverage proves the tombstone rule, archived and Trash-only threads surviving, durable page resume,
token-specific cursor reset, authentication cancellation, local-snapshot isolation, scope-transition safety,
resumable candidate verification, reminder cleanup, and pending local deltas replaying on top of server truth.
Existing purge reconciliation coverage pins direct-fetch 404 deletion. Seeded Electron coverage removes one
thread absent from a completed account listing while preserving archived and partially trashed mail.
Expired-history recovery now converges cached membership and existence without ghost rows or lost local actions.

---

## The feature half: order and open assumptions

Nine tasks, T22 through T30. They keep M2's `T` numbering rather than continuing `S1`–`S4`, because the `S`
names describe the sync restructure and no id is ever reused. Two tracks run in parallel and meet at the
palette:

```
A  T22 mailboxes ──> T27 splits ──> T28 chord guide ──> T29 inbox zero
B  T23 FTS index ──> T24 search UI ──> T25 server search
   T26 palette   ── depends on A and B registering their commands, asserts the inventory last
   T30 built-in themes ── independent, schedule it wherever it fits
```

T22 goes first because S2 and S4 exist to serve it, because the store already answers its questions, and
because All Mail is what forces list windowing to stop being conditional. T23 can start the same day: it
touches `persist.ts` and the schema, not the renderer, so the two tracks do not collide.

**Two assumptions this plan makes. Both are owner calls, and ratifying them belongs in SPEC §9.**

1. **F3 registers palette commands, T26 builds the palette.** F3's acceptance criteria say every mailbox is
   reachable by palette and keyboard, and no palette exists today (`commands.ts` is a registry whose own
   comment calls the palette "future"). Blocking F3 on the palette would invert the dependency for no gain,
   so T22 through T25 register their entries in `COMMAND_SPECS` and T26 builds the surface and asserts the
   inventory. `AGENTS.md` already phrases the rule this way.
2. **Search targets §7's stated budget, and measures for the unanswered one.** The gate is p95 under 100 ms
   at 50,000 messages. The pathological-mailbox question below is still open, so T23 records measured index
   size and query latency at 50k and at the largest profile available, and those numbers answer the question
   instead of a guess made now.

---

## T22 — System mailbox navigation

**Status: not started.**

**Depends on:** S2, S4 (both done) · **Unblocks:** T27, and T24's `in:` operator · **Parallel with:** T23 ·
**Spec:** F3 system mailbox navigation, §9 #10, §5 `G` chords

### Why

The store holds every mailbox and the renderer shows four views. `MailView` in `Inbox.tsx:32` is
`inbox | snoozed | drafts | outbox`, while `listMailboxThreadIds` (`db/queries.ts:76`) already owns the All
Mail, Spam, and Trash membership rules S2 shipped and no IPC read reaches it. It returns ids, not rows,
because it was built ahead of this task to make the rules testable.

This is the task S2 and S4 were paid for. It is also where windowing stops being conditional.

### Design (decided)

- **One `MailboxView` union in `src/shared/mail.ts`:** `inbox`, `allMail`, `sent`, `drafts`, `starred`,
  `snoozed`, `spam`, `trash`. Outbox stays outside the union. F3 is explicit that Outbox is an on-demand
  operational view, not a mailbox, and T16 already built it that way.
- **One typed read.** `mail:listThreads({ view })` replaces the `mailListThreads` / `mailListSnoozed` pair
  in `src/shared/ipc.ts`. Drafts keeps its own row shape (`DraftList` merges outbox rows with cached Gmail
  drafts) and Snoozed keeps its reminder fields. Every filter and every sort stays in SQL. A renderer that
  fetches the inbox and filters it for Sent has already lost the 50 ms budget at 10,000 rows.
- **`listMailboxThreadIds` grows into `listMailboxThreads`**, returning the same projection as
  `listInboxThreads` under the membership rules S2 recorded: Spam and Trash include a thread when any message
  carries the label and sort by that mailbox's newest matching message, All Mail includes a thread when any
  message is outside Spam and Trash. Sent is `SENT` and Starred is `STARRED`, both with the junk exclusion the
  normal reader already applies.
- **The trashed-message marker is reader behavior, not an action.** A normal or All Mail conversation shows
  `This message was moved to Trash. Show message.` at the message's chronological position. `Show message`
  reveals it in the current reader only. It changes no label, queues no action, and resets when the reader
  closes. Spam and Trash readers keep S2's behavior of showing only their own messages.
- **Per-view selection and scroll.** Keep one record per view and restore it on return. Switching mailboxes
  closes an open reader, per F3.
- **Windowing becomes unconditional.** Delete `VIRTUALIZE_AT = 500` (`ThreadList.tsx:86`) and window every
  list. All Mail at the 10,000-row `THREAD_LIST_LIMIT` is now the ordinary case, and keeping two layout paths
  keeps two sets of scroll-restore bugs. The row height and overscan constants stay.
- **Triage removes a row when it stops matching the active view.** The inbox predicate generalizes per view:
  archiving in All Mail removes nothing, trashing in Inbox removes the row, restoring in Trash removes it
  there. v1 still ships no permanent delete and no empty-folder action in Spam or Trash.
- **Commands are registry data, not dispatch code.** Add `view.allMail` (`g a`), `view.sent` (`g t`),
  `view.starred` (`g s`), `view.spam` (`g p`), `view.trash` (`g r`) beside the existing four.
  `useKeyboardDispatch.ts:47` already resolves two-key chords from the registry, so nothing in dispatch
  changes. Palette entries stay registry-only until T26.
- **The list header shows the active mailbox name** (`MailHeader`), which is the whole of F3's answer to not
  having a sidebar.

### Implementation guide

- Renderer: `Inbox.tsx` view state and `switchView`, `MailHeader`, `ThreadList` windowing, `useMailData`.
  Route every view transition through `exitConversation()` before changing the view. This checkpoints an
  inline reply before React unmounts its composer.
- Main: `db/queries.ts` (`listMailboxThreads`), the service handler and protocol operation in
  `src/main/service/`, the preload bridge, and the channel map. All three IPC halves in one commit
  (global rule 2).
- Testids: `mailbox-title`, `mailbox-row`, `trashed-message-marker`, `trashed-message-reveal`.
- Screenshot artifacts: `all-mail.png` and `trash-marker.png`. Add both to the `AGENTS.md` list in the same
  PR (global rule 8).

**Schema:** none. Every rule this task needs shipped with S2 at revision 16.

### Testing

- **Unit:** the view-to-query mapping, each membership rule against a seeded in-memory database, and the
  reader's marker placement for a thread whose middle message is trashed. Extend `queries.test.ts` rather
  than starting a parallel file.
- **E2e (seeded):** every `G` chord reaches its view; the existing mixed-label fixture appears in both All
  Mail and Trash with the right message subset in each reader; per-view selection and scroll survive a round
  trip; a triage verb removes a row from a view it no longer matches; a Drafts row opens the composer; a
  boot with no provider still switches views. Extend `e2e/message-labels.spec.ts` seeds with one Sent-only
  and one Starred-only thread rather than reordering the existing fixture list.
- **Perf (@perf):** switching to All Mail on the 10,000-thread profile renders under the F3 50 ms budget,
  and scrolling holds the existing `requestAnimationFrame` interval now that every list is windowed.

### Done when

Eight views render from SQLite, a cached switch is measured under 50 ms in the perf suite, both artifacts are
reviewed, and verify is green.

---

## T23 — FTS5 index in the utility process

**Status: not started.**

**Depends on:** S1 (done) · **Unblocks:** T24, T25 · **Parallel with:** T22 · **Spec:** F10, §6, §7

### Why

F10 runs entirely locally, so the index is the feature. S1 put the only SQLite writer in the utility process,
which is where the index write path belongs. Nothing about this task is visible, which is the argument for
making it its own PR: the index has to be correct under delete, tombstone, and hydration before a UI can
trust it.

### Design (decided)

- **The indexed unit is the message.** Columns: subject, sender, recipients, body, filenames. Thread ranking
  takes the best-matching message per thread, so a thread whose fifth message matches ranks on that message.
- **Write inside the same transaction as the row.** `persistThread` (`sync/persist.ts`) indexes every message
  it writes. `sync/bodies.ts` and `sync/onDemandBodies.ts` update the body column when hydration fills it.
  Every delete path removes index rows in the same transaction: S4's tombstone pass, S2's draft-only pruning,
  and account teardown. An index that outlives its rows returns results that open onto nothing.
- **Coverage follows the store, and the UI has to say so.** Headers are lifetime once the sweep completes.
  Body terms and filenames match hydrated mail only. `has:attachment` is lifetime-wide after the attachment
  walk. T24 renders that disclosure; T23 exposes the state it needs.
- **Index text, not markup.** Index `messages.body_text`. When a row has HTML and no text, derive it with
  `textFromRaw('text/html', …)` from `gmail/parse.ts`, which is the same DOM-free helper `mergeBodies.ts`
  already uses to fill `body_text` during hydration. Do **not** reach for `shared/mailSanitizer.ts`: it
  configures a live DOMPurify instance and needs a DOM, which the utility process does not have. The
  sanitizer's job is safe rendering, and this one is stripping tags before tokenizing. Indexing markup
  produces matches on `div`.
- **Backfilling existing rows is a fourth cursor, not a fifth mechanism.** A resumable pass in the utility
  process, keyed by the `fts_cursor` column this task adds to `sync_state`, running at background priority
  behind the three sync cursors and yielding to interactive work (global rule 7). It resumes from SQLite
  after a supervisor restart exactly as the other three do.
- **Tokenizer and prefix index:** `unicode61 remove_diacritics 2`, with `prefix='2 3'` for as-you-type. The
  prefix index costs storage. Measure it rather than assuming it.
- **Table shape.** FTS5 cannot delete by a text key without a scan, so a mapping table owns the rowid.
  `sync_state` is a column per cursor, not a key-value table, so the backfill cursor is a column too.
  Revision 18 adds:

```sql
ALTER TABLE sync_state ADD COLUMN fts_cursor TEXT;

CREATE TABLE message_fts_map (
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  fts_rowid  INTEGER NOT NULL,
  PRIMARY KEY (account_id, message_id)
);
CREATE UNIQUE INDEX idx_message_fts_map_rowid ON message_fts_map (fts_rowid);
CREATE INDEX idx_message_fts_map_thread ON message_fts_map (account_id, thread_id);

CREATE VIRTUAL TABLE message_fts USING fts5(
  subject,
  sender,
  recipients,
  body,
  filenames,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);
```

  The alternative worth one hour before writing code is an external-content table over `messages`, which
  removes the duplicate text at the cost of a synthetic integer key on a table whose primary key is
  `(account_id, id)`. Pick one, record why, and move on. Whichever wins, the delete path must be a rowid
  delete.
- **Update the cursor contract in the same PR.** [Where sync stands today](#where-sync-stands-today) says
  three cursors, not two. `fts_cursor` makes it four, and that prose is what the next task reads before
  touching sync.

**Schema revision 18.** For a stopped revision-17 dogfood profile, apply the DDL above plus the version stamp
in one transaction under the `AGENTS.md` procedure:

```sql
BEGIN IMMEDIATE;
ALTER TABLE sync_state ADD COLUMN fts_cursor TEXT;
CREATE TABLE message_fts_map (
  account_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  thread_id  TEXT NOT NULL,
  fts_rowid  INTEGER NOT NULL,
  PRIMARY KEY (account_id, message_id)
);
CREATE UNIQUE INDEX idx_message_fts_map_rowid ON message_fts_map (fts_rowid);
CREATE INDEX idx_message_fts_map_thread ON message_fts_map (account_id, thread_id);
CREATE VIRTUAL TABLE message_fts USING fts5(
  subject,
  sender,
  recipients,
  body,
  filenames,
  tokenize = 'unicode61 remove_diacritics 2',
  prefix = '2 3'
);
PRAGMA user_version = 18;
COMMIT;
```

The change is additive and indexes nothing until the backfill pass runs, so existing mail, contact, reminder,
and action counts must be unchanged before relaunch.

### Testing

- **Unit** against `openDatabase(':memory:')`: insert, update, and delete parity between `messages` and the
  index; a hydrated body becoming searchable; a tombstoned thread leaving no index rows; prefix and diacritic
  matching; the backfill pass resuming from a persisted cursor.
- **E2e:** the utility-process crash spec gains a case that kills the process mid-backfill and asserts the
  index continues from `fts_cursor` with no duplicate rows, matching how the other three cursors are covered.
- **Perf (@perf):** p95 query latency and on-disk index size on the generated profile, both recorded in
  [T20-EVIDENCE.md](T20-EVIDENCE.md). These numbers are the input to the pathological-mailbox question.

### Done when

The index is maintained transactionally on every write and delete path, the backfill resumes across a
relaunch and a supervisor restart, latency and size are recorded, and verify is green.

---

## T24 — Search UI, operators, and local results

**Status: not started.**

**Depends on:** T23 · **Unblocks:** T25 · **Spec:** F10, §5 `/`

### Design (decided)

- **The parser is a pure shared module,** `src/shared/searchQuery.ts`, because T25's server row and T26's
  palette both need to parse the same string. Operators: `from:`, `to:`, `subject:`, `in:`, `is:`,
  `has:`, `before:`, `after:`. Quoted phrases survive. Anything unrecognized is literal search text, never an
  error: a user typing `re: budget` is searching, not writing a malformed query.
- **Two halves, one query.** Text terms hit FTS5; `is:`, `has:`, `in:`, `before:`, and `after:` become SQL
  predicates over `threads`, `messages`, and `thread_labels`. The utility process runs them as one statement
  and returns ranked threads. `in:` accepts T22's mailbox names and user labels.
- **Results are a view, not a mode.** `/` focuses a field in the list header; results replace the list using
  the same row component and the same reader behavior. `Esc` returns to the previous mailbox with its
  selection and scroll intact, and a second `Esc` behaves as it does in that mailbox.
- **Typing is never blocked.** Debounce, cancel the in-flight query on the next keystroke, and render the
  last complete result set until the next one lands.
- **One quiet coverage line** under the results states what the store cannot answer yet, driven by T23's
  state. F10 promises header matches lifetime-wide and body matches for hydrated mail, and a user who does
  not know that reads a missing old body as a broken search.
- **Commands:** `search.open` (`/`) and `search.clear`, registry-only until T26.

### Testing

- **Unit:** a parse table covering each operator, combinations, quoting, unknown operators as text, and
  empty input; the query builder producing the same result set as a hand-written control query.
- **E2e (seeded):** results appear as you type; F10's own acceptance combination
  (`from:acme.com has:attachment after:2026-01-01`) returns the fixture thread and only that thread; a result
  opens into the reader and `Esc` returns twice, correctly.
- **Perf (@perf):** p95 under 100 ms at 50,000 messages. The profile generator currently scales threads, so
  this task teaches it a message-count mode.

### Done when

F10's two acceptance criteria are measured rather than asserted, and verify is green.

---

## T25 — On-demand thread fetch and "Search all of Gmail"

**Status: not started.**

**Depends on:** T24 · **Spec:** F10

### Why

The server row needs to fetch and persist a thread the store has never seen. The app has no such primitive
today, and it is useful well beyond search: a notification for an unsynced thread, a shared link, and any
future "open this id" path all want it.

### Design (decided)

- **The primitive comes first, with one owner.** A function that fetches a single thread id at the requested
  format, persists it through `persistThread`, and returns the stored thread. Foreground priority, through
  the quota limiter, honoring the same auth-pause behavior as every other provider call. Recovery paths in
  `poller.ts` already do a version of this; factor them onto the new function rather than leaving two.
- **Server search reuses the parsed query.** Translate the parsed structure into Gmail `q=` syntax, run it,
  and merge ids under a divider below the local results. A thread present locally keeps its local row. Threads
  the server returns are persisted through the normal write path and stay cached, which F10 requires.
- **Failure is visible.** Offline disables the row and says why. A quota wait shows as a wait, not as an empty
  result. An auth pause routes into the existing reconnect surface.

### Testing

- **Unit:** query translation to Gmail syntax; merge and dedupe ordering; the fetch primitive against a mock
  provider, including a 404 and a transient error, asserting one persisted thread and no duplicate rows.
- **E2e (seeded):** the seeded provider serves one thread absent from the local store; invoking the row
  persists it, opens it, and it survives `boot.relaunch()`.

### Done when

An arbitrary thread id can be fetched and cached by one code path, server results merge without duplicates,
and verify is green.

---

## T26 — Command palette, registry completeness, and the reader keys

**Status: not started.**

**Depends on:** T22 and T24 registering their commands · **Spec:** F5, §5, §9 #18d

### Why

Every task since M1 has registered commands into `COMMAND_SPECS` for a palette that does not exist. F5 calls
the palette the app's primary control surface, and its engineering rule ("no feature ships reachable only by
mouse") is an honor system until a test asserts the inventory.

### Design (decided)

- **`Mod+K` from anywhere.** Fuzzy match with exact prefix ranked above fuzzy score, boosted by recent and
  frequent use, persisted per account in `settings`.
- **The registry stays the single source.** Each row renders its shortcut from `COMMAND_SPECS`, so a command
  added without a shortcut shows without one instead of drifting into a second list. Context filtering uses
  the existing `CommandContext` values.
- **Parameterized commands share their parsers.** "Remind me tomorrow 9am" parses through the same
  natural-language code the snooze picker uses. Do not fork it for the palette.
- **Bind `N`, `P`, and `O` in the reader** (next message, previous message, expand or collapse), which §9 #18d
  decided on 2026-08-17 and deferred to exactly this task.
- **The completeness assertion is a test, not a paragraph.** Enumerate every user-facing feature's command id
  and fail when one is missing. Keeping the list in the test is what makes it break when someone adds a
  feature and forgets.

### Testing

- **Unit:** ranking, including prefix beating fuzzy and recency breaking ties; context filtering; the
  inline-argument parse path.
- **E2e (seeded):** the palette opens from list, reader, and composer contexts and dispatches a command in
  each; every `G` chord's command also appears in the palette; `N`, `P`, and `O` move and collapse messages
  in the reader.
- **Perf (@perf):** open under 50 ms, re-rank under 30 ms, per F5.

### Done when

Every command in the registry is reachable and asserted, the reader keys are bound, F5's two budgets are
measured, and verify is green.

---

## T27 — Split inbox, rules, and per-split notifications

**Status: not started.**

**Depends on:** T22 · **Unblocks:** T28's digit completions, T29's remaining-split counts ·
**Spec:** F11, F12 (the per-split slice), §5 `←`/`→` and `G` `1`–`9`

### Design (decided)

- **Splits are read-time views over the Inbox list.** First matching rule wins, every inbox thread lands in
  exactly one split, and mail is never moved. Evaluating at read time means a rule change re-buckets by
  re-rendering, which satisfies F11's "under 1s for 10k threads" by construction and avoids a denormalized
  column that can disagree with its rules.
- **Defaults are Important and Other.** Important reads Gmail's `IMPORTANT` label, which `thread_labels` and
  `labels_json` already carry, so no new fetch is needed.
- **User rules match sender address, sender domain, `List-Id`, or label.** `List-Id` is not stored. Add
  `messages.list_id` and add `List-Id` to `METADATA_HEADERS` (`gmail/provider.ts:19`). Existing rows stay
  `NULL` until an ordinary refetch fills them, exactly as S2's legacy labels do, so address, domain, and label
  rules work on day one while list rules ramp. Say that in the rule editor rather than letting it look broken.
- **The strip follows D6:** a horizontal top-bar strip, unread counts on hot splits, overflow behind `···`
  past about eight. `←`/`→` moves between splits, `G` then `1`–`9` jumps by configured order, and each split
  keeps its own selection.
- **F12's slice lands here.** A per-split notify flag, default Important only, feeding `planNotifications`
  and `applyUnreadBadge` in `notify.ts`. The badge counts notification-enabled splits, which is what F12 has
  said since M1 staging.
- **The rule manager is minimal.** F15's settings surface is M4. T27 ships rule creation, ordering, and
  deletion, reachable by palette command, and no more.

**Schema revision 19.** For a stopped revision-18 profile:

```sql
BEGIN IMMEDIATE;
ALTER TABLE messages ADD COLUMN list_id TEXT;
CREATE TABLE split_rules (
  account_id TEXT NOT NULL,
  id         TEXT NOT NULL,
  position   INTEGER NOT NULL,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  match_json TEXT NOT NULL DEFAULT '[]',
  notify     INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, id)
);
CREATE INDEX idx_split_rules_order ON split_rules (account_id, position);
PRAGMA user_version = 19;
COMMIT;
```

### Testing

- **Unit:** the matcher, covering rule order, first match wins, a thread matching two rules landing in one
  split, a malformed rule being skipped rather than throwing, and `NULL` `list_id` falling through; the
  notification planner honoring per-split flags and the badge counting only enabled splits.
- **E2e (seeded):** `←`/`→` and `G` digits switch splits; each split keeps its selection; unread counts are
  per split; adding a rule re-buckets without a reload; splits never appear outside Inbox.
- **Perf (@perf):** a rule change re-buckets the 10,000-thread profile under 1s.

### Done when

F11's two acceptance criteria are measured, per-split notification and badge behavior is covered, and verify
is green.

---

## T28 — The contextual chord guide

**Status: not started.**

**Depends on:** T22, T27 · **Spec:** §9 #14, F5

### Design (decided)

- The footer's default state is one non-wrapping line of commands relevant to the active view, derived from
  the registry rather than from a hand-kept list in `MailFooter`.
- A pending chord prefix replaces that line with the valid completions, again from the registry: fixed
  mailbox letters from T22, and split digits from T27's configured order.
- **Reconcile the two timeouts before writing UI.** Dispatch holds a pending chord for 500 ms
  (`useKeyboardDispatch.ts:56`) and §9 #14 wants the guide visible for 2 to 3 seconds. A guide that outlives
  the chord it describes is a lie the user acts on. Pick one number, 2 seconds, and use it in both places.
  Raising the dispatch window is a behavior change to a shipped key path, so it needs its own test.
- The guide clears on completion, `Esc`, a view change, or that timeout. The palette and the cheat sheet stay
  the exhaustive references.

### Testing

- **Unit:** completions derived from the registry for each context, including a view with no split digits.
- **E2e (seeded):** the default line per view; `G` showing mailbox letters and split digits; dismissal by
  each of the four routes; the raised chord window still completing `g i` and still expiring.
- **Screenshot artifact:** `chord-guide.png`, added to the `AGENTS.md` list.

### Done when

The guide is registry-derived, the two timeouts agree, and verify is green.

---

## T29 — Inbox zero

**Status: not started.**

**Depends on:** T27 · **Spec:** F13

### Design (decided)

- When the active split reaches zero, a full-pane zero state replaces the list: a rotating bundled background
  image, a short affirmation, the time, and the remaining splits with counts. Images ship in the asar. No
  network, ever, for a reward screen.
- **Gate it on sync state.** A fresh profile mid-backfill has an empty inbox because nothing has arrived yet,
  and showing "you are done" to someone who has not seen their mail is the failure mode this task has to
  avoid. Read the backfill phase from `sync_state` and show sync progress instead until the inbox stage
  completes.

### Testing

- **E2e (seeded):** archiving the last thread in a split shows the zero state with the other splits' counts;
  a profile whose backfill has not reached the inbox stage does not show it.
- **Screenshot artifact:** `inbox-zero.png`, added to the `AGENTS.md` list.

### Done when

The zero state appears only when the mailbox is genuinely empty, and verify is green.

---

## T30 — Built-in themes

**Status: done.**

**Depends on:** nothing · **Parallel with:** everything · **Spec:** F14, D6

### Design (revised 2026-08-23)

- The dark tokens already exist as semantic names in `app.css` (`--color-ground`, `--color-raised`,
  `--color-ink`, `--color-accent`, and the rest). Every palette is another value set over the same names. If
  a component needs a new token to change palettes, the token is missing from the system and the fix is the
  token, not a conditional in the component.
- Ship four curated palettes: Dark, Light, Midnight, and Sand. This is intentionally more
  like VS Code's small built-in collection than a three-state System/Light/Dark switch. User-authored token
  sets and accent editing remain v1.1 work.
- Follow the OS by default by resolving System to the dark/light pair. A named palette is a manual
  override stored in `settings` and does not change when the OS changes. Expose each choice in the account
  menu and register it for the command palette.
- **Mail rendering is the hard half.** HTML mail carries its own colors. The light theme leaves mail canvases
  alone, dark keeps the behavior `mailSurface.ts` ships today, and F14's per-message "view original" escape
  hatch stays. Do not guess at luminance inversion in v1.

### Testing

- **Unit:** a check that renderer components carry no raw color literals outside the token file, which is
  what keeps the light theme from rotting one component at a time.
- **E2e:** Light artifacts `inbox-light.png` and `reading-light.png`, persistence for a named theme,
  and an OS-preference switch applying without a reload. Add both artifacts to the `AGENTS.md` list.

### Done when

All four themes are legible across list, reader, composer, and HTML mail, the override persists across
relaunch, System reacts to OS changes without a reload, and verify is green.

---

## Out of scope for M3

Snippets (F8), follow-up reminders (F9), the full settings surface (F15), AI reply drafting (F17), and
auto-update with signing are M4. T27 ships a minimal split-rule editor because splits are useless without
one; that is not the start of F15.

---

## Open questions

**Decided 2026-08-22:** the utility process owns SQLite (SPEC §9 #19), and S2 landed before S1. S1's design
constraints carry the consequences.

| Question | Why it matters | Decide by |
|---|---|---|
| Pathological-mailbox posture: pick a design target such as smooth to 250k messages, then throttle harder, cap, or expose a setting? | §7's budgets are written against 50k messages, and lifetime headers can exceed that | E7's real-mailbox capture in [T20-EVIDENCE.md](T20-EVIDENCE.md), plus T23's measured index size and query latency |
| Does F3 ship with registry-only palette commands, with T26 building the palette and asserting the inventory? | It decides whether T22 or T26 goes first, and F3's acceptance criteria name the palette | Before T22 starts |

Open defects and coverage gaps live in [KNOWN-ISSUES.md](KNOWN-ISSUES.md). Manual sign-off evidence is ticked
in [T20-EVIDENCE.md](T20-EVIDENCE.md).
