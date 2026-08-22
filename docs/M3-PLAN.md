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
| Feature half | **open**, not planned | nothing yet |

S2 settled the store shape needed for F3 mailbox views and S4, S1 moved that store into the utility process,
and S4 closed the last sync correctness gap. The feature tasks get written up from here.

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
   snapshot and every schema change bumps `CURRENT_SCHEMA_VERSION`, currently 16. Throwaway profiles may be
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

Existence has exactly two trustworthy signals:

1. Absence from an unfiltered thread-id listing walked to exhaustion **in the same run**, plus the SPAM and
   TRASH listings, since the unfiltered walk excludes both.
2. A per-thread `threads.get` returning 404.

Membership reconciliation therefore never deletes. The tombstone pass runs only when a full existence sweep is
in hand, which expiry recovery or a lifetime re-walk can supply, or it verifies each candidate individually and
deletes on 404 alone. Partial pages prove nothing. A network truncation must never delete real mail.

S2 now provides the per-message truth S4 needs to distinguish a partially trashed live thread from a purged
one.

### What shipped

- `reconcileThreadExistence` runs first during expired-history recovery, before the replacement history
  checkpoint is recorded. It walks Gmail's unfiltered, Spam, and Trash thread-id listings to exhaustion at
  background priority.
- Each run writes its evidence to a unique temporary SQLite table. It queries local ids missing from the
  completed union, deletes those snapshots through `deleteThread`, then drops the table. The set does not
  occupy JavaScript heap and needs no schema change.
- An interrupted listing or authentication-generation change drops the temporary evidence and deletes
  nothing. The expired checkpoint remains durable until tombstoning finishes, so a process interruption also
  retriggers the whole pass. Partial pages never become deletion evidence.
- A concurrent lifetime header walk yields while expiry recovery owns foreground sync. It resumes from its
  independent durable cursor after the tombstone pass, with no second lifetime owner or cursor reset.
- Membership reconciliation still calls `replayPendingThreadDeltas`, and tombstoning leaves `action_queue`
  rows intact. Server truth wins without silently discarding a user's queued action.
- The test-only seam `attn:test:runExistenceSweep` drives the pass through main, the utility
  process, and the real seeded SQLite store without contacting Gmail.

### Testing and done condition

Unit coverage proves the tombstone rule, an archived thread with no system label surviving, an interrupted
listing deleting nothing, authentication cancellation deleting nothing, and pending local deltas replaying
on top of server truth. Existing purge reconciliation coverage pins direct-fetch 404 deletion. Seeded Electron
coverage removes one thread absent from a completed account listing while preserving archived and partially
trashed mail. Expired-history recovery now converges cached membership and existence without ghost rows or
lost local actions.

---

## Still to be planned

These are the milestone's feature half. They get planned once the remaining sync work is underway and the
store's shape is settled.

- **F10, FTS5 instant search and operators**, including the "Search all of Gmail" server row and the
  on-demand thread fetch it implies. Fetching and persisting an arbitrary thread id is a primitive the app
  does not have today, and it is useful beyond search.
- **F3, system mailbox navigation** (Inbox, All Mail, Sent, Drafts, Starred, Snoozed, Spam, Trash) with `G`
  chords and palette entries. List virtualization stops being conditional at All Mail scale. F3 also keeps a
  chronological marker for each trashed message hidden inside a normal or All Mail conversation. Its
  `Show message` action reveals the message locally without restoring it. This is reader behavior, not a new
  message-level trash action.
- **F11, split inbox and rules.**
- **Inbox-zero states, F14 themes, and palette hardening**, with every command registered and asserted.
- **§9 #14, the contextual chord guide** in the shortcut footer, deferred from M2.
- **§5 reader keys `N`, `P`, and `O`.** Decided 2026-08-17: bind them, do not cut them (SPEC §9 #18d). They
  land with palette hardening's registry-completeness assertion.

---

## Open questions

**Decided 2026-08-22:** the utility process owns SQLite (SPEC §9 #19), and S2 landed before S1. S1's design
constraints carry the consequences.

| Question | Why it matters | Decide by |
|---|---|---|
| Pathological-mailbox posture: pick a design target such as smooth to 250k messages, then throttle harder, cap, or expose a setting? | §7's budgets are written against 50k messages, and lifetime headers can exceed that | E7's real-mailbox capture in [T20-EVIDENCE.md](T20-EVIDENCE.md) |

Open defects and coverage gaps live in [KNOWN-ISSUES.md](KNOWN-ISSUES.md). Manual sign-off evidence is ticked
in [T20-EVIDENCE.md](T20-EVIDENCE.md).
