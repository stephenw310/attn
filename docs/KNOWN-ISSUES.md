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

## Bugs

### BUG-1: a non-retryable mirror failure stalls every later draft *(review B3)*

**Verified:** 2026-08-21 · **Severity:** medium · **Pairs with:** REF-2

`mirrorExecutor.ts:118` returns on a non-retryable `GmailApiError` without setting a timer or marking the row.
`drainDraftMirrors` orders by `updated_at` (`mirror.ts:56`), so the same rejected row is selected first on every
trigger. Newer drafts never mirror, and Gmail receives one rejected request per poll cycle, indefinitely.

Nothing surfaces in the UI, so a week of drafts can fail to mirror with no visible symptom. That makes it a poor
thing to carry into a dogfood run.

**Fix direction:** an in-memory `nextAttemptAt` map keyed by row id is enough, and needs no schema change. The
alternative is to continue to the next row instead of returning. Either one closes REF-2 in the same change.

### BUG-2: leaving a conversation mid-reply drops the draft *(review B6)*

**Verified:** 2026-08-22 · **Severity:** medium, data loss

`Inbox.tsx` derives the inline composer from `readerOpen && selected.id === composerDraft.threadId`.
`closeReader` routes through `inlineComposerRef.current.exitConversation()` (`Inbox.tsx:490`), but `switchView`
(`Inbox.tsx:340`) and `openOutbox` (`Inbox.tsx:352`) do not. They set `readerOpen = false` and leave
`composerDraft` intact, so the keyed inline `<Composer>` unmounts and a full-window one mounts from the object
captured at open.

`useComposerDraft`'s unmount clears timers without flushing. Edits inside the 5 second checkpoint window are
lost outright. Edits that did checkpoint disappear from the editor and are overwritten in SQLite on the next
keystroke. The header nav and the Outbox button stay enabled during inline compose, and `composer.spec.ts:964`
pins that they do, so nothing stops a user from hitting this.

**Fix direction:** route both transitions through `exitConversation()` the way `closeReader` does. Add an e2e
that clicks "Drafts" mid-reply and asserts the draft body survives.

### BUG-3: bulk labelling shows one thread's state and applies it to all *(review B7)*

**Verified:** 2026-08-22 · **Severity:** low-medium

`Inbox.tsx:798` passes `targets={[{ id: labelTarget.id, ... }]}`, which is the focused thread alone, while
`useTriage.ts:41` rewrites `threadIds` to the whole selection and then calls `clearSelection()`.

Select three threads, press `l`, and toggle a label the focused row already carries. The picker offers "remove"
based on that one row, then removes the label from all three, including the two that never had it. Because the
selection is cleared on the first action, the next toggle in the still-open picker applies to the focused thread
alone. `LabelPicker` already renders multi-target `some` states, so the component is not the blocker.

No e2e covers bulk labelling.

**Fix direction:** pass the real selection as `targets` when a selection exists, and decide explicitly whether
the picker stays open across a bulk apply. Add the missing e2e.

---

## Security hardening

### SEC-1: crafted clipboard JSON puts unsanitized HTML into outgoing mail *(review S1)*

**Verified:** 2026-08-22 · **Severity:** medium, sanitizer bypass

`OpaqueHtmlNode.importJSON` (`nodes/OpaqueHtmlNode.tsx:133-134`) constructs the node straight from
`serialized.html`. Every other route into an opaque region passes the composer's import sanitizer first.

Three things line up to make that reach the wire:

1. The composer's paste handler (`Composer.tsx:364`) calls `preventDefault` only when the clipboard carries
   image files. Anything else falls through to Lexical's default importer, which reads
   `application/x-lexical-editor` and calls `importJSON`. The only gate is the editor namespace, and that is
   the fixed public string `attn-composer` (`editorConfig.ts:13`).
2. `serializeEditorState` (`serialize.ts:92-94`) runs `restoreOpaqueHtml` **after** `sanitizeOutgoingHtml`, by
   design. While the sanitizer runs, the payload sits base64url-encoded inside `data-attn-opaque`, which
   `sanitize.ts:210` explicitly allows through untouched.
3. `restoreOpaqueHtml` (`preserve.ts:415-417`) is a raw string replace. It decodes the payload back into the
   body with no sanitization.

Confirmed by probe on 2026-08-22: feeding `<script>alert(1)</script><img src=x onerror=alert(2)>` through
`restoreOpaqueHtml(sanitizeOutgoingHtml(...))` returns it intact. So this is an outgoing-mail sanitizer bypass,
not defense in depth. The harm lands on the recipient's mail client, not locally, because the reader is a
scriptless sandbox under CSP. Exploitability depends on Chromium carrying a custom MIME type across
applications on the clipboard, which is plausible but untested.

`ImageNode.importJSON` (`nodes/ImageNode.tsx:50-53`) takes `serialized.src` raw by the same route.

**Decided 2026-08-22:** the owner asked for this to ship with the BUG-1, BUG-2 and BUG-3 fix pass rather
than on its own.

**Fix direction:** decode, run `sanitizeDraftHtmlForImport`, then re-encode inside `OpaqueHtmlNode.importJSON`
and `importDOM`, so the node type cannot hold unsanitized HTML however it was built. Sanitizing at the restore
step instead would also close it, and would cover any future path into an opaque region. Give the sibling nodes
the same treatment for raw `style` and `src`.

### SEC-2: the quote CSS filter misses several flow-escaping properties *(review S2)*

**Verified:** 2026-08-22 · **Severity:** low, recipient-side cosmetics only

`FLOW_ESCAPING_PROPERTY` (`shared/mailSanitizer.ts:51`) matches
`position|z-index|inset|top|right|bottom|left|transform`. It does not match the standalone `translate`,
`rotate`, and `scale` properties, `offset-*`, or `text-indent`.

Custom-property indirection also slips the negative-margin check. `NEGATIVE_LENGTH` tests the literal value, so
`--m: -600px; margin: var(--m)` passes because `var(--m)` contains no digit.

Either gap lets quoted content leave normal flow and land on top of the reply the user wrote, which is what the
filter exists to prevent.

**Fix direction:** extend the property list, and either resolve custom properties before the value check or drop
declarations whose value references `var(`.

---

## Test coverage gaps

Each was verified against the acceptance criteria in SPEC §4 and the plan docs' Testing bullets.

### GAP-1: "a reply during snooze wakes it" is asserted nowhere

**Verified:** 2026-08-21 · **Criterion:** F4

Implemented at `poller.ts:184-186` calling `SnoozeScheduler.wakeThread`. In tests, `wakeThread` appears only as a
`vi.fn()` on a fake scheduler (`syncController.test.ts:120,171`), so nothing asserts the real behavior.

**Wanted:** a poller unit test that an inbound message triggers `wakeThread`; a scheduler unit test that it
returns the pending reminder; an e2e that snoozes `t-roadmap`, injects inbound mail, and expects the chip.

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

### REF-2: per-row mirror backoff *(review R4)*

**Verified:** 2026-08-21 · **Same change as:** BUG-1

Give `drainDraftMirrors` a `skip` predicate and let the executor own per-row backoff, matching the action
executor's shape. This is BUG-1's fix seen as a simplification.

### REF-3: two MIME builders with subtly different header rules *(review R6)*

**Verified:** 2026-08-21

`outbox/mime.ts` (464 lines, send) and `outbox/draftMime.ts` (319 lines, draft mirror) each implement CRLF and
RFC 2047 encoding separately. The two encoders must agree, and no test asserts that they do.

### REF-4: outbox row deserialization is hand-rolled at eight sites *(review R7)*

**Verified:** 2026-08-21

`outbox/drafts.ts`, `outbox/mirror.ts`, `outbox/queue.ts`, `outbox/sender.ts`, and `outbox/draftSync.ts` all
parse rows inline, and `draftSync.ts` alone does it four times. No shared row-to-object helper exists.

### REF-5: `outbox.remote_updated_at` is written and never read *(review R10)*

**Verified:** 2026-08-21

Written in five places, read in none. Conflict resolution uses the freshly parsed `remote.updatedAt` and
`remote_fingerprint` instead. Drop the column at the next schema bump rather than bumping the version for it
alone.
