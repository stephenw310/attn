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

**Defects below come from the 2026-09-02 sweep.** [REVIEW-2026-09-02.md](REVIEW-2026-09-02.md) is the
whole-codebase re-review that this paragraph used to ask for; its bug, security, refactor and deletion findings
carry `B`/`S`/`R`/`D` ids there, and the entries here cite them. Low-severity items and the deletion list stay in
the review rather than being copied here — pick them up from that document.

Sources so far: the 2026-08-16 review of `main` @ #52 ([REVIEW-2026-08-16.md](REVIEW-2026-08-16.md)), its
coverage map ([REVIEW-2026-08-16-coverage.md](REVIEW-2026-08-16-coverage.md)), and the 2026-09-02 review of
`main` @ #107 ([REVIEW-2026-09-02.md](REVIEW-2026-09-02.md)). All three are frozen snapshots kept for their
reasoning. This file is the part that stays current. Each entry cross-references its original review
tag, because the review's `S1` and `S2` security tags collide with the `S1` through `S4` task names in
M3-PLAN.

A finding already attached to a planned task stays with that task instead of moving here. The review's B4
pruning edge shipped with M3 S2 on 2026-08-22. M3-PLAN records its coverage and keeps the status current.

Milestone and task status stays in [SPEC.md](SPEC.md) §8 and the plan docs, per [AGENTS.md](../AGENTS.md).
Manual sign-off evidence is ticked in [T20-EVIDENCE.md](T20-EVIDENCE.md). Nothing here is a milestone gate
unless a plan doc says so.

---

## Product defects

Each was verified against `main` @ ee4fe41 on 2026-09-02. The review id in parentheses points at the full
reasoning and fix direction in [REVIEW-2026-09-02.md](REVIEW-2026-09-02.md).

### BUG-11: `preserve.ts` strips `background-color` from blocks, breaking F6 zero-loss silently *(review B11)*

**Verified:** 2026-09-02 · **Severity:** medium

`INHERITED_TEXT_STYLES` (`src/renderer/src/composer/preserve.ts:121`) lists `background-color`, which is not
inherited; `materializeInheritedTextStyles` moves it onto text spans and deletes it from the cell or div, with no
"preserved" banner. Fix: remove it from the set; add a shaded-cell round-trip test.

### BUG-12: the composer's quote preview uses the outgoing allowlist, not the reader's *(review B12)*

**Verified:** 2026-09-02 · **Severity:** medium

`InlineQuote` (`src/renderer/src/composer/Composer.tsx:336-347`) sanitizes with `sanitizeOutgoingHtml`, which
drops `style`, headings, `hr`, `pre`; the `forceLightMailCss` branch there is dead. Fix falls out of REF-8.

## Test coverage gaps

Each was verified against the acceptance criteria in SPEC §4 and the plan docs' Testing bullets.

### GAP-2: `outbox/drafts.ts` CRUD has no unit tests

**Verified:** 2026-08-31 (re-checked: `drafts.test.ts` still covers none of the five) · **Owed by:** T14A's Testing bullets

`reopenThreadDraft`, `closeDraft`'s delete-versus-tombstone branch, `listDrafts` ordering and empty exclusion,
`takeRecoveredDraft`, and `upgradeReplyToReplyAll` are untested. `drafts.test.ts` exists but covers the
attachment trust boundary and lifecycle guards, not these five.

The original reason was a belief that SQLite cannot load under vitest. It can. `openDatabase(':memory:')` works,
as `outbox/{spool,queue,inlineImages}.test.ts` show.

### GAP-3: no assertion that a DRAFT never drives the thread snippet

**Verified:** 2026-08-31 (re-checked) · **Owed by:** T14B

Only the `nonDraftMessages` filter is unit-tested. The `t-roadmap` fixture's newest message is a DRAFT, which
makes it the natural place to assert the row's snippet and `last_msg_at`, but no test does.

### GAP-4: offline bulk replay runs at N=3, not N=20

**Verified:** 2026-08-31 · **Criterion:** F2 "airplane mode: 20 archives"

`triage.spec.ts:347` (the offline-replay loop) still runs three iterations. The perf suite now covers the F4 side of scale, with a 100-thread
archive and undo at 10,000 threads (`perf.spec.ts:394`), so this is the remaining scale gap.

### GAP-5: crash recovery is tested with a graceful quit

**Verified:** 2026-08-31

`boot.relaunch()` calls `boot.app.close()` (`e2e/electron.ts:141`). The plan itself calls this an approximation.
A SIGKILL variant would make the continuous-typing and queued-row cases real force-kills rather than clean
shutdowns.

### GAP-6: the T18 auth-pause e2e injects a 401, not `invalid_grant`

**Verified:** 2026-08-31

`testIpc.ts` forwards `failNextActionAuth` (line 83), whose utility handler installs an action failure with status 401. The promised case is a failed token refresh. That
path is unit-covered (`client.test.ts:22-26`, `executor.test.ts:239,278`), so the e2e is a fidelity gap rather
than an untested path.

### GAP-7: frame-timed perf metrics are unmeasurable in the current cloud container

**Verified:** 2026-08-31 · **Owed by:** T37A's performance bullet / T40's perf evidence

`composer-keystroke-paint-delta` (`measureComposerKeystroke` in `e2e/perf.spec.ts`) reports alternating
~900ms samples in the Claude Code cloud container: the hidden Electron window paints at roughly 1Hz there,
so every other keystroke waits most of a second for its frame. This is environmental, not a regression —
commit `cbb899e` (T35, before any AI code) measures identically, and keystroke **mutation** medians stay at
4–5ms throughout, including with autocomplete enabled against a delayed fake provider. The T37A probe
additions (`composer-keystroke-mutation-autocomplete`, `composer-autocomplete-accept`) are in place but the
paint-side assertions cannot pass in this container.

The 2026-08-31 full `e2e:perf` run (recorded in [T40-EVIDENCE.md](T40-EVIDENCE.md)) confirms the scope is
every frame-timed metric, not just the composer: search-keystroke-to-results reads a constant ~1,013ms
(the 1Hz frame), scroll-frame pacing and one split-switch p95 outlier fail the same way, while every
non-paint metric passes well inside budget (warm account switch p95 42ms vs the 100ms F18 budget,
composer open 10ms, keystroke mutation medians 4–5ms) and `e2e:perf:scale` passes outright.

**Wanted:** run `npm run e2e:perf` on hardware with real vsync (the T20-EVIDENCE convention) and record
the frame-timed numbers in T40's exit checklist.

## Refactors

These are proposals, not defects. Nothing here is required for a milestone. Each one is recorded because
somebody found and verified it, not because it is scheduled.

### REF-1: two components far exceed the ~350-line bar *(review R3)*

**Verified:** 2026-08-31

`Composer.tsx` is 1,397 lines and `Inbox.tsx` is 2,458, against the bar R1 set at roughly 350; both grew
through M3–M4 (splits, settings deep links, follow-ups, AI drafting). Clean seams exist:
`InlineQuote` plus `quoteSrcDoc` out of the composer, and the label and snooze picker wiring out of `Inbox`.

### REF-3: two MIME builders with subtly different header rules *(review R6)*

**Verified:** 2026-08-31

`outbox/mime.ts` (465 lines, send) and `outbox/draftMime.ts` (319 lines, draft mirror) each implement CRLF and
RFC 2047 encoding separately. The two encoders must agree, and no test asserts that they do.

### REF-4: outbox row deserialization is hand-rolled at eight sites *(review R7)*

**Verified:** 2026-08-31 (re-checked; `sender.ts` gained T35's follow-up columns in the same inline style)

`outbox/drafts.ts`, `outbox/mirror.ts`, `outbox/queue.ts`, `outbox/sender.ts`, and `outbox/draftSync.ts` all
parse rows inline, and `draftSync.ts` alone does it four times. No shared row-to-object helper exists.

### REF-5: five sync runners hand-roll the same cursor walk *(review R1)*

**Verified:** 2026-09-02

`lifetimeSweep.ts`, `attachmentFlags.ts`, `splitMetadata.ts`, `ftsBackfill.ts`, and `backfill.ts` each re-implement
cursor grammar, yield/pacing, the one-shot expired-token reset, checkpoint, `progress()` and the `onError` guard;
only `isExpiredPageTokenError` and `persistThread` are shared, and four test suites re-test the same skeleton. A
`runCursorWalk` leaves each runner as its per-item body.

### REF-6: ~42% of the utility runtime is e2e seam code *(review R2)*

**Verified:** 2026-09-02

`src/main/service/runtime.ts:944-1645` (`handleTest` and its nine helpers, seven guards, five delay fields) exist
only for the harness; AGENTS.md isolates main's seams in `testIpc.ts` but the utility half never got the same
treatment. `ai/manager.ts` carries a fake provider the same way. Move to `service/testOperations.ts`.

### REF-7: the outbox state machine is bypassed for most transitions *(review R3)*

**Verified:** 2026-09-02

`sender.ts:488-493,656-661,780-786` write transitions as raw SQL that `machine.ts` also models; five events are
never dispatched and six `machine.test.ts` cases cover unreachable paths. Route every transition through
`planTransition` (which retires BUG-3 and BUG-6 structurally) or delete the unused events.

### REF-8: mail-frame plumbing is copied four times *(review R5)*

**Verified:** 2026-09-02

Frame registration and remote-image epoch handling at `MessageBody.tsx:456-493`, `Composer.tsx:226-275`,
`OpaqueHtmlNode.tsx:387-435`, `ImageNode.tsx:46-81`; iframe measurement three times; three divergent srcdoc
shells. A `useMailFrameAccess` hook plus `<MailFrame>` also fixes BUG-12.
