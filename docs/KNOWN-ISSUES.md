# Known issues

This file lists live defects and gaps on `main`. It is the triage list. Every entry here is unfixed as of its
**Verified** date, and each one carries the evidence needed to pick it up cold.

**This is not a status archive.** Delete an entry in the PR that fixes it. Do not mark it done, strike it
through, or move it to a "fixed" section. A file that accumulates closed items stops being read. The PR that
removes a line is the record that it closed.

**Adding an entry.** Give it the next free ID in its section, a one-line symptom, a `file:line` anchor, the
concrete failure it produces, and a fix direction. Verify the anchor against `main` before you write it and
stamp the date. IDs are never reused.

**Always name the symbol, not only the line.** Line numbers drift fast: six anchors in this file moved when
#65 landed, one day after they were written, while every defect they described was untouched. Read the line
as a hint and the symbol as the truth, and re-stamp the date when you correct a drifted anchor.

Sources so far: the 2026-08-16 review of `main` @ #52 ([REVIEW-2026-08-16.md](REVIEW-2026-08-16.md)) and its
coverage map ([REVIEW-2026-08-16-coverage.md](REVIEW-2026-08-16-coverage.md)). Both are frozen snapshots kept
for their reasoning. This file is the part that stays current. Each entry cross-references its original review
tag, because the review's `S1` and `S2` security tags collide with the `S1` through `S4` task names in
M3-PLAN.

A finding already attached to a planned task stays with that task instead of moving here. The review's B4
pruning edge shipped with M3 S2 on 2026-08-22. M3-PLAN records its coverage and keeps the status current.

Milestone and task status stays in [SPEC.md](SPEC.md) §8 and the plan docs, per [AGENTS.md](../AGENTS.md).
Manual sign-off evidence is ticked in [T20-EVIDENCE.md](T20-EVIDENCE.md). Nothing here is a milestone gate
unless a plan doc says so.

---

## Test coverage gaps

Each was verified against the acceptance criteria in SPEC §4 and the plan docs' Testing bullets.

### GAP-2: `outbox/drafts.ts` CRUD has no unit tests

**Verified:** 2026-08-21 · **Owed by:** T14A's Testing bullets

`reopenThreadDraft`, `closeDraft`'s delete-versus-tombstone branch, `listDrafts` ordering and empty exclusion,
`takeRecoveredDraft`, and `upgradeReplyToReplyAll` are untested. `drafts.test.ts` exists but covers the
attachment trust boundary and lifecycle guards, not these five.

The original reason was a belief that SQLite cannot load under vitest. It can. `openDatabase(':memory:')` works,
as `outbox/{spool,queue,inlineImages}.test.ts` show.

### GAP-3: no assertion that a DRAFT never drives the thread snippet

**Verified:** 2026-08-21 · **Owed by:** T14B

Only the `nonDraftMessages` filter is unit-tested. The `t-roadmap` fixture's newest message is a DRAFT, which
makes it the natural place to assert the row's snippet and `last_msg_at`, but no test does.

### GAP-4: offline bulk replay runs at N=3, not N=20

**Verified:** 2026-08-22 · **Criterion:** F2 "airplane mode: 20 archives"

`triage.spec.ts:344` loops three times. The perf suite now covers the F4 side of scale, with a 100-thread
archive and undo at 10,000 threads (`perf.spec.ts:394`), so this is the remaining scale gap.

### GAP-5: crash recovery is tested with a graceful quit

**Verified:** 2026-08-21

`boot.relaunch()` calls `boot.app.close()` (`e2e/electron.ts:132`). The plan itself calls this an approximation.
A SIGKILL variant would make the continuous-typing and queued-row cases real force-kills rather than clean
shutdowns.

### GAP-6: the T18 auth-pause e2e injects a 401, not `invalid_grant`

**Verified:** 2026-08-21

`testIpc.ts:219` installs an action failure with status 401. The promised case is a failed token refresh. That
path is unit-covered (`client.test.ts:22-26`, `executor.test.ts:239,278`), so the e2e is a fidelity gap rather
than an untested path.

---

## Refactors

These are proposals, not defects. Nothing here is required for a milestone. Each one is recorded because
somebody found and verified it, not because it is scheduled.

### REF-1: two components far exceed the ~350-line bar *(review R3)*

**Verified:** 2026-08-22

`Composer.tsx` is 1,060 lines and `Inbox.tsx` is 829, against the bar R1 set at roughly 350. Both grew
again in #65. Clean seams exist:
`InlineQuote` plus `quoteSrcDoc` out of the composer, and the label and snooze picker wiring out of `Inbox`.

### REF-3: two MIME builders with subtly different header rules *(review R6)*

**Verified:** 2026-08-21

`outbox/mime.ts` (464 lines, send) and `outbox/draftMime.ts` (319 lines, draft mirror) each implement CRLF and
RFC 2047 encoding separately. The two encoders must agree, and no test asserts that they do.

### REF-4: outbox row deserialization is hand-rolled at eight sites *(review R7)*

**Verified:** 2026-08-21

`outbox/drafts.ts`, `outbox/mirror.ts`, `outbox/queue.ts`, `outbox/sender.ts`, and `outbox/draftSync.ts` all
parse rows inline, and `draftSync.ts` alone does it four times. No shared row-to-object helper exists.
