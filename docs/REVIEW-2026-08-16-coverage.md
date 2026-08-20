# Attn — test-coverage map at the end of M2 feature work (2026-08-16)

Companion to [REVIEW-2026-08-16.md](REVIEW-2026-08-16.md). Maps SPEC §4 acceptance criteria and every M2-PLAN task's *Testing* bullets to the tests that exist on `main` @ c2ad85a, with file:line evidence. It is the raw material for the T20 exit-checklist item "F6 acceptance criteria each demonstrably pass (list them in the closing PR with evidence links)". Produced by a read-only sub-review; the headline claims were re-verified by hand before the review was written. Line numbers refer to `main` @ c2ad85a (this branch adds a few tests, so later files shift slightly).

Legend: **COVERED** (e2e) / **UNIT** (covered at unit level, named) / **PARTIAL** / **MANUAL ONLY** (documented as such in the plan) / **GATED** (M3 scope, or real Gmail excluded by harness design) / **GAP**.

## 0. Headline findings

1. **T21 is unimplemented and untested.** No `syncLabels` anywhere in `src/` (the poller has only `syncDrafts`, `src/main/sync/poller.ts:205,280`); `listLabels` is called once at `src/main/sync/backfill.ts:98`; `upsertLabels` (`src/main/sync/persist.ts:33-39`) is upsert-only. F2's "change made in Gmail web reflected within one poll interval" is false for label create/rename/delete.
2. **No performance acceptance criterion is enforced by `npm run verify`.** `playwright.config.ts` grep-inverts `@perf` unless `ATTN_E2E_PERF=1`; the perf seed is 2,000 threads (`e2e/perf.spec.ts:153,168`), not 10,000; ceilings are 1500/1500/2500/150/250 ms (`perf.spec.ts:5-10`) vs SPEC's 50/16 ms. Nothing measures scroll frame rate or a 100+ selection.
3. **F4 "a reply during snooze surfaces it immediately" has zero coverage:** `effects.wakeThread` (`src/main/sync/poller.ts:184-186`) and `SnoozeScheduler.wakeThread` (`src/main/scheduler.ts:39-49`) are asserted nowhere (`wakeThread` appears in tests only as a `vi.fn()` on a fake scheduler in `syncController.test.ts`).
4. AGENTS.md's artifact list was stale (6 of 12) — fixed in this branch.
5. Outbox/sender/machine/draftSync coverage is strong and matches the plan's promises almost line for line. Crash-recovery e2e cases exist, with one caveat: `boot.relaunch()` is a graceful `app.quit()` (`e2e/electron.ts:128-134`), not a SIGKILL — the plan itself calls this an approximation.

## 1. SPEC §4 acceptance criteria → tests

### F2 — Sync engine & offline (SPEC.md F2 acceptance criteria)

| Criterion | Status | Evidence |
|---|---|---|
| Airplane mode: archive 20, quit, relaunch online → all 20 sync, none lost/duplicated | PARTIAL (e2e at N=3, durability half) + UNIT (drain half) | `e2e/triage.spec.ts:335` archives 3, relaunches, asserts 5 rows + "3 pending" (:338-345). Drain: `src/main/actions/executor.test.ts:199` (row deleted after success, :212), `src/main/syncController.test.ts:568` (offline retry restarts sync), :681 (`resumeOnlineWork` drains). "None duplicated" against real Gmail: MANUAL. |
| Kill mid-sync → no corruption; next launch resumes from stored historyId | UNIT + e2e analog | `backfill.test.ts:253` "resumes mid-backfill without resetting its checkpoint", :182, :209; `poller.test.ts:110` "advances the checkpoint last", :260; `lifetimeSweep.test.ts:137,155,267`. e2e analog for the lifetime cursor: `e2e/lifetime-sweep.spec.ts:61` (interrupt at page-2 → relaunch → resumes at page-2, :93-122). Mid-poll kill needs Gmail → GATED. |
| Change in Gmail web reflected within one poll interval | UNIT + GATED; GAP for labels | `poller.test.ts:79-108` (planner), :110 (apply), :317 (15s/60s cadence). Real Gmail → GATED. Label create/rename/delete never reaches the catalog (T21). |
| Network loss → Offline while reads/triage keep working; restore → Live and drains queue | PARTIAL (transitions injected) | `e2e/seeded.spec.ts:119` drives phases via `attn:test:setSyncState` (:206-232 offline → retry → `online` event → live); `e2e/hydration.spec.ts:19` real `setOffline(true)`, reads keep working; `triage.spec.ts:335`. Drain-on-restore: `syncController.test.ts:568,595,681`; `sync/retry.test.ts:36`; `sync/failure.test.ts:6`. No e2e drives a real connectivity drop through poller+executor end to end. |

### F3 — Inbox list & conversation view

| Criterion | Status | Evidence |
|---|---|---|
| 60fps scroll on a 10,000-thread list | GAP | Only `perf.spec.ts:154` (2k threads, render time not frame rate, 1500 ms ceiling, opt-in). T20 item 1 open. |
| Cached conversation opens < 50ms; Esc returns instantly with scroll + selection intact | PARTIAL: functional COVERED, latency opt-in | `e2e/smoke.spec.ts:169` "Enter opens the reader; J/K navigates; boundary K, Back, and Esc restore the list", :276 "restores list scroll on reader exit…". Latency: `perf.spec.ts:167` (1500 ms, @perf). |
| Auto-advance never lands on a stale row | COVERED | `triage.spec.ts:8`; :90 rapid `e e` → 6 rows / 2 pending (:120-121); :348 reader advance. |
| Full recipient set ≤2 interactions; attachments download to OS Downloads and are revealed | PARTIAL | Recipients: `e2e/reading.spec.ts:47`. Attachments: `reading.spec.ts:128` asserts metadata + signed-out toast (:167); the download+reveal path (`src/main/ipc.ts` `mailDownloadAttachment`) has only filename-safety units (`src/main/attachments.test.ts:8-26`). No test writes to a downloads dir or asserts `showItemInFolder`; not listed as manual in M2-PLAN. |
| Quote/signature collapsing never blanks a card, never hides without expander, instant, control stays, no remount | COVERED | `reading.spec.ts:47,172,190`; `e2e/html-mail.spec.ts:8` (:132-153 stability marker survives `mail:changed`; :209-218 expand without remount). Unit: `src/renderer/src/mailTrim.test.ts`. |
| Keyboard/pointer open transfers reading keys; J/K; reading keys scroll; frame focus never strands loop; no horizontal shift | COVERED | `smoke.spec.ts:169`; `html-mail.spec.ts:8` (:156-160 ArrowDown scrolls, :184-189 keys forwarded from focused frame, :199-203, :219-221 Esc from frame, :271-273 Shift+# from frame); `triage.spec.ts:398`. |
| Every system mailbox reachable; cached switch < 50ms | GATED (M3) | Present views only: Drafts `g d` (`composer.spec.ts:215`), Snoozed (`snooze.spec.ts:30`), Outbox `g o` (`composer.spec.ts:395,:434`). |

### F4 — Triage actions & undo

| Criterion | Status | Evidence |
|---|---|---|
| Visual feedback < 16ms, incl. selections of 100+ | GAP (scale + latency) | `perf.spec.ts:184` single-row `e`, 2500 ms, opt-in. Largest bulk in suite is 3 rows (`triage.spec.ts:129`). |
| `Z` reverses bulk archive of 100 locally and server-side | PARTIAL (N=3 local; server-side unit) | `triage.spec.ts:129` (3 rows, :173-186), :8, :90; inverse planning `src/main/actions/plan.test.ts:19`; bulk-undo survivors `src/main/actions/revert.test.ts:41`. No N=100 case. |
| Snoozed returns within 60s / on next launch; a reply during snooze surfaces it | PARTIAL → GAP for reply-wake | `snooze.spec.ts:177` "returns a due snooze… returned chip", :193 "catches up a snooze that became due while the app was closed"; `scheduler.test.ts:76-103`. Reply-wake: no test. |
| Snoozed view (`G` then `H`) | COVERED | `snooze.spec.ts:30, :77, :166`. |

### F6 — Compose, send & undo send

| Criterion | Status | Evidence |
|---|---|---|
| Composer < 50ms open; < 16ms/keystroke | GAP in verify; opt-in only | `perf.spec.ts:197` — 150 ms open / 250 ms keystroke (M2-PLAN T14 promised a 100 ms open ceiling). |
| Force-quit mid-compose → draft recovers | COVERED (graceful relaunch approximates force-quit, per plan) | `composer.spec.ts:1605` (mirrored draft, undo cannot erase, :1628-1634), :1653 continuous typing, :1637, :1669 (failed autosave retried), :1684 (discard leaves nothing). Unit: `useComposerDraft.test.ts:102`. |
| Undo within window always succeeds; nothing reaches network before window closes | COVERED + UNIT (ordering) | `composer.spec.ts:248` (toast bound to durable deadline :261-280, `z` reopens recipients/subject/body :282-288, pending → 0). Ordering: `machine.test.ts:18` (queue → persist/arm/notify; timer before send_at only re-arms), :27, :38 (`sending` persisted before `send`); races `queue.test.ts:82-127`; `actions/index.test.ts:50-59`. |
| No scenario produces a duplicate send | UNIT (exhaustive) + MANUAL ONLY (real Gmail) | `machine.test.ts:52-57, :59, :68, :77, :87, :97, :161`; `sender.test.ts:41` (create→persist→update→send order), :72, :139 (send 404 = consumed), :155, :174, :593, :615, :636 (adopts orphan, never creates replacement), :657, :675; `gmail/provider.test.ts:122-256` (`findByRfcId` searches drafts + messages, never promotes an unverified hit). Real-Gmail forced-crash matrix: MANUAL ONLY (M2-PLAN T16 manual smoke, T20). |

## 2. M2-PLAN task Testing bullets → status

### R3
Fixture with Message-ID/References + Reply-To ≠ From: COVERED — `e2e/fixtures/seed-inbox.json:31-48` (`t-roadmap`), asserted `seeded.spec.ts:45-61`. Composer page object: COVERED — `e2e/composer.ts` (`openNew`/`openReply` :54, `expectPending` :127, `expectSaved` :132, all retrying). Clock seam: COVERED — `SchedulerTime` used by `scheduler.test.ts:75`, `sender.test.ts`, `mirrorExecutor.test.ts`, `lifetimeSweep.test.ts:181`.

### T13
| Bullet | Status | Evidence |
|---|---|---|
| Unit: header extraction (angle brackets, folded References) | COVERED | `src/main/gmail/parse.test.ts:124,155` |
| Unit: contact ranking (decay, prefix > infix, self-exclusion) | COVERED | `src/shared/contacts.test.ts:19,31,42,56` |
| Unit: cursor routing (fresh, mid, completed, recovery restart) | COVERED | `backfill.test.ts:245,253,299,209` |
| E2e idempotency: persist twice → unchanged; delete source → unique contact disappears, others survive | COVERED (both halves) | `seeded.spec.ts:45` — replay via `reloadSeed` :89-103 (`toBeCloseTo` score); delete via `deleteThread` :105-116 (Priya gone, Maya survives) |
| E2e: headers via getConversation; ranked contacts; log shows sent stage skipped | COVERED | `seeded.spec.ts:46-61, :63-87`, log :41 |
| Manual smoke | MANUAL ONLY | |

### T13A
| Bullet | Status | Evidence |
|---|---|---|
| Cursor routing/resume | UNIT | `lifetimeSweep.test.ts:92,137,267` |
| Skip-if-present against seeded stores | UNIT | `lifetimeSweep.test.ts:106` |
| Priority/yield/throttle on SchedulerTime | UNIT | `lifetimeSweep.test.ts:181`; `syncController.test.ts:464` |
| Contact idempotency across T13 overlap | e2e (not unit) | `seeded.spec.ts:89-103`; `lifetime-sweep.spec.ts:106,139` |
| SPAM/TRASH contact exclusion | e2e (not unit) | `e2e/contact-hygiene.spec.ts:5` (SPAM, TRASH, CHAT); rule at `persist.ts:170` has no direct unit |
| E2e: partial sweep across relaunch/offline; no body bytes; unread unchanged | COVERED | `lifetime-sweep.spec.ts:61` — `formats: ['metadata','metadata']` (:96), unread unchanged (:99,:123), inbox ids unchanged (:100-102,:124-128), resume at page-2 (:110-122) |
| Manual wall-clock/quota | MANUAL ONLY | |

### T14
| Bullet | Status | Evidence |
|---|---|---|
| Unit: sanitizer allowlist, plain-text nested lists, recipient parse, ranking, autosave rejection after unmount, mirror-executor shutdown | COVERED | `composer/sanitize.test.ts:7,49,63`; `serialize.test.ts:35,56`; `shared/address.test.ts:5,15`; `contacts.test.ts`; `useComposerDraft.test.ts:102`; `mirrorExecutor.test.ts:42,77` |
| E2e: `c` focused at To, list/reader + footer invisible | COVERED | `composer.spec.ts:503` (:509-519) |
| Chips accept/reject comma names + pending text | COVERED | :608 (:616-637), :503 (:526-536) |
| Esc saves, toasts, restores exact prior list/reader | COVERED | :503 (:557-562), :1582 (reader) |
| Clean close remains closed across launch | COVERED | :608 (:639-645); "`c` reactivates" superseded by T14A |
| Relaunch reopens draft even when mirror_revision caught up; undo cannot erase | COVERED | :1605 (`markDraftMirrored` :1621, Ctrl/Cmd+Z :1633-1634) |
| Second relaunch case: continuous typing proves max-wait checkpoint | COVERED, robustness note | :1653: `pressSequentially(…, {delay:100})` ~9 s then immediate `boot.relaunch()`, asserts first 40 chars (:1661-1666). Discriminates because `before-quit` teardown removes IPC handlers synchronously (`src/main/index.ts` teardown) before the 1 s idle timer could land a save; an explicit pre-relaunch `draft.get` would make that independent of quit timing. |
| Typing never triggers list verbs | COVERED | :503 (:544-549) |
| Sign-in screen registers nothing | COVERED | `smoke.spec.ts:80` |
| Perf: open < 100 ms; keystroke sampled | PARTIAL, opt-in | `perf.spec.ts:197` uses 150/250 ms; excluded from verify |
| composer.png | COVERED | `composer.spec.ts:551-555` (after pasting a PNG :547) |

### T14A
| Bullet | Status | Evidence |
|---|---|---|
| Unit: local thread-slot reuse | GAP at unit; e2e PARTIAL | `reopenThreadDraft` (`src/main/outbox/drafts.ts:118-136`) has no unit; e2e :658 shows Enter reusing the reply id as replyAll (:721-724), row-click reopen (:712-714), forward reopen (:743-745). No test presses `r` twice and asserts the same id. |
| Unit: empty-draft discard | GAP at unit; e2e PARTIAL | `closeDraft` delete branch (`drafts.ts:379-381`) has no unit; e2e :648 asserts toast + `draft-row` count 0 (:653-655), but `listDrafts` excludes empties by design, so DB-row absence is not directly proven. |
| Unit: list ordering / empty exclusion | e2e instead | :1549; no `listDrafts` unit |
| E2e: two drafts from `g d` | COVERED | :503 (:564-575) |
| E2e: Esc on empty draft leaves no row | PARTIAL (above) | :648 |
| E2e: reply chip + reopen via `r` | PARTIAL | chip :709/:756/:891; reopen via row-click and J (:712-714, :882-906); via `r` again — not asserted |
| E2e: relaunch with three drafts lists all three | COVERED | :1549 (:1574-1579, N=3, newest first) |

### T14B
| Bullet | Status | Evidence |
|---|---|---|
| Unit: prefill mapping planReply → outbox row, all kinds | e2e instead | mapping is inline in `src/main/ipc.ts` (`draftCreateReply`), no pure unit; e2e :658 (:667-673, :721-726, :732-736), :220, :1515 |
| Unit: persistThread skips DRAFT and leaves last_msg_at/snippet driven by newest real message | PARTIAL | `persist.test.ts:6` tests only the `nonDraftMessages` filter. Nothing asserts thread `last_msg_at`/snippet: fixture `t-roadmap` has the DRAFT newest (`seed-inbox.json:52-65`) but no e2e reads `thread-snippet`/time for that row. |
| E2e: threaded reply draft never appears as a message | COVERED | `seed-inbox.json:52-65` (`m-roadmap-draft`, DRAFT) + `composer.spec.ts:662,:671` and `seeded.spec.ts:36` assert `message-card` count 2 |
| E2e: `r` Reply-To prefill + collapsed quote; `a` To+Cc minus self; `f` empty | COVERED | :673,:684-686; :725-726; :736 |

### T14C
| Bullet | Status | Evidence |
|---|---|---|
| Unit: fidelity check flags exactly the unrepresentable | COVERED | `composer/preserve.test.ts:8-116` |
| Unit: opaque regions byte-identical | COVERED | `preserve.test.ts:148,157,164` |
| Unit: MIME golden for multipart/related | PARTIAL | `mime.test.ts:12` is an inline assertion; fixtures (`src/main/outbox/fixtures/*.eml`) have no related-inline case |
| E2e: paste an image, see it in body and composer.png | COVERED | `composer.spec.ts:547` `pasteVisiblePng` (:36-62) → screenshot :551-555; body/CID :576,:584; also :1132 |
| E2e: seeded table draft renders, survives edit, unchanged on save | COVERED | :1064 (:1093-1108) |
| Invariant test: image + table + coloured span; edited; byte-identical outside edited region | PARTIAL | :1064 asserts containment: `<table>` present, colour matches `#c00` **or** `rgb(204, 0, 0)` (:1107 — represented content is not byte-identical, by design), opaque `<section>` byte-identical (:1108). Saved HTML never checked for `<img`. Byte-identity proven only for the opaque region (unit `preserve.test.ts:148,157`). |

### T14D
| Bullet | Status | Evidence |
|---|---|---|
| Unit: three-way decision table | COVERED | `draftSync.test.ts:29,33` |
| Unit: open-composer immunity | COVERED | `draftSync.test.ts:39` |
| Unit: backfill cursor resume across `drafts` phase | COVERED | `backfill.test.ts:166` |
| E2e: closed-draft remote edit adopted; open-draft edit deferred until close | COVERED | `composer.spec.ts:1418` (:1451-1471 adopt; :1473-1479 deferred then adopted) |
| Verify Bcc round-trips | COVERED in two halves | outbound: `draftMime.test.ts:28-38` (`Bcc:` in checkpoint MIME); inbound: `composer.spec.ts:1469`. No single local→Gmail→local test. |
| Reconcile two Gmail drafts on one thread twice; ids distinct/stable | COVERED | :1482 (:1498-1512); unit `draftSync.test.ts:395,423` |

### T14E
| Bullet | Status | Evidence |
|---|---|---|
| Unit: remote drafts bind only when thread exists locally | COVERED | `draftSync.test.ts:148,155,177` |
| Reply/reply-all/forward keep message cards visible | COVERED | `composer.spec.ts:671` |
| Draft chip on row | COVERED | :709, :955 |
| Inbox-bound and archived-parent Gmail forward drafts → inline | COVERED | :935 (:961-1000) |
| Row restores draft in viewport after long HTML settles | COVERED | :1003 (:1036-1050), :658 (:664-682) |
| Quoted history same native/presentation surface | COVERED | :689-694 (native), :1007-1016 (light) |
| `r`/`f` from selected list row | COVERED | :220 |
| `Enter` opens Reply all | COVERED (e2e + unit) | :721-726; `renderer/src/commands.test.ts:207` |
| Back and Esc exit to originating list | COVERED | :705-707, :740-742, :968-971 |
| inline-reply.png, draft-chip.png | COVERED | :699-703, :956-960 |

### T15
Golden files (simple, html+text, attachment, non-ASCII, References chain): COVERED — `mime.test.ts:197` `it.each(CASES)` over five fixtures. Reply-plan table: COVERED — `replyPlan.test.ts:34-178`. Naive-splitter property check: COVERED — `mime.test.ts:327`.

### T16
| Bullet | Status | Evidence |
|---|---|---|
| Machine matrix incl. every crash point | COVERED | before `sending` write (still queued → boot catch-up): `machine.test.ts:171`, `sender.test.ts:817`; after `sending` write: `machine.test.ts:52-53` → `verify`, `sender.test.ts:593`; after network-ambiguous error: `sender.test.ts:693` (stays `sending`, not undoable), `machine.test.ts:113`; between drafts.create and id persistence: `machine.test.ts:54` → `verify-secondary`, `sender.test.ts:72` (no update/send), :636 (adopts orphan) |
| draft-present ⇒ resend, draft-404 ⇒ sent | COVERED | `machine.test.ts:59`; `sender.test.ts:174,:593` |
| Bounded secondary search never resends on one negative | COVERED | `machine.test.ts:77,:161`; `sender.test.ts:615` |
| needs-review parking | COVERED | `machine.test.ts:87,:97`; `sender.test.ts:615` (:626-633), :675 |
| Window catch-up on boot | COVERED | `machine.test.ts:171`; `sender.test.ts:817` |
| Undo-after-fire | COVERED | `machine.test.ts:27`; `actions/index.test.ts:59`; `queue.test.ts:83-127` |
| E2e: Mod+Enter queues + toast with undo | COVERED | `composer.spec.ts:248` (:255-281) |
| E2e: `z` inside window reopens composer intact | COVERED | :282-288 |
| E2e: window elapse → provider-gate visible as pending | COVERED | :395 (:400 delay 0, :422-425 queued with `send_at ≤ now`, pending 1) |
| E2e: pending click + command route open Outbox; actionable row reopens intact | COVERED | :418-422, :434-437, :437-443; failed membership :446 (:488-499) |
| E2e: relaunch with a queued row preserves it | COVERED | :395 (:431-443) and :291 (:322-328 with attachment) |
| E2e: reply prefill quoted history + Reply-To | COVERED | :658 (:673,:684-686) |
| Manual exactly-once matrix | MANUAL ONLY | |

### T17
| Bullet | Status | Evidence |
|---|---|---|
| Unit: spool naming/cleanup, cap math, MIME framing with spooled files | COVERED | `spool.test.ts:43,135,164,197`; `mime.test.ts:36,81`; `draftMime.test.ts:136` |
| E2e: pick and drop a seeded fixture file | COVERED | `composer.spec.ts:291` (`pickAttachments` :302, `dropFiles` :333, `e2e/fixtures/t17-attachment.txt`) |
| Chip renders with size | COVERED | :305-306 |
| Discard cleans the spool (assert via relaunch) | COVERED | :335-338 |
| Oversize rejection toast | COVERED | :342 (:351-352) |
| Manual checksum send | MANUAL ONLY | |

### T18
| Bullet | Status | Evidence |
|---|---|---|
| Unit: permanent/retryable/auth incl. token refresh | COVERED | `actions/execute.test.ts:37,48`; `gmail/client.test.ts:22,26` |
| Unit: snooze/unsnooze/auto-return convergence | COVERED | `executor.test.ts:457,486,514` |
| Unit: local DB error boundaries | COVERED | `executor.test.ts:568,642` |
| Unit: undo-stack invalidation | COVERED | `actions/revert.test.ts:8,24,41` |
| Unit: sequential toast batching | COVERED | `shared/actionRevert.test.ts:21`; `actions/revertNotices.test.ts:16`; `preload/actionRevertDelivery.test.ts:93` |
| E2e: permanent failure via seam → back in list, toast, pending 0, `z` doesn't re-archive | COVERED | `triage.spec.ts:22` (:32-42) |
| E2e: refresh-token auth pause → reconnect → same-account resume → drain | PARTIAL | `triage.spec.ts:45` (:54-71) drives the flow, but the seam injects an HTTP 401 (`installActionFailure(threadId, 401)`), not `invalid_grant`. Refresh-token path is UNIT: `client.test.ts:22-26`, `execute.test.ts:48`, `executor.test.ts:239,278`; same-account copy `renderer/src/actionReconnect.test.ts:23`. |

### T19
Unit: needs-hydration predicate COVERED — `sync/bodyHydration.test.ts:6-21`. E2e: metadata-only thread opens with placeholder COVERED (functional; "instantly" not timed) — `hydration.spec.ts:5`, offline :19. Online hydration: MANUAL ONLY. Open budget: opt-in `perf.spec.ts:167`.

### T21
GAP — feature not implemented. None of "poller invokes syncLabels once per cycle", "throwing effect does not fail the cycle", "upsertLabels add/rename/delete", or the seed-reload e2e exist. Adjacent coverage to copy: `syncDrafts` seam tests at `poller.test.ts:232,245`.

### M3-PLAN S3
| Bullet | Status | Evidence |
|---|---|---|
| Cursor routing/resume across every new phase incl. retired `sent` token | COVERED | `backfill.test.ts:245,253,286` "routes a retired sent cursor to the all-mail stage without its page token", :153,:166 |
| Skip-if-present against a seeded store (no fetch for present ids) | COVERED | `backfill.test.ts:134` (`getThread` called once, only for `fresh`, :149-150) |
| Mock provider receives explicit SPAM/TRASH listings + unfiltered 12-month query | COVERED | `backfill.test.ts:62` (:77-104); `gmail/provider.test.ts:6,25` |
| CHAT rows skipped | COVERED | `persist.test.ts:6`; `contact-hygiene.spec.ts:5` |
| E2e: seeded profile reaches new stages in order, reaches done | PARTIAL | `seeded.spec.ts:119` asserts footer narration via injected `setSyncState`; a seeded account skips real stages by design, so progression itself is unit-only (`backfill.test.ts:62-116`) |

## 3. Screenshot artifacts

All written to `e2e/.artifacts/`: login.png (`smoke.spec.ts:113`), inbox.png (`smoke.spec.ts:328`), reading.png (`html-mail.spec.ts:223`), simple-mail.png (`html-mail.spec.ts:247`), label-picker.png (`labels.spec.ts:66`), auth-paused.png (`triage.spec.ts:61`), composer.png (`composer.spec.ts:551`), inline-reply.png (`composer.spec.ts:699`), draft-chip.png (`composer.spec.ts:956`), attachments.png (`composer.spec.ts:307`), newsletter-quote.png (`composer.spec.ts:1017`), gmail-draft.png (`composer.spec.ts:1240`). AGENTS.md now lists all twelve.

## 4. Harness hygiene

- Fixed sleeps: one `page.waitForTimeout(250)` at `e2e/html-mail.spec.ts:140` — a deliberate stability check (iframe height must *not* change over 250 ms after a `mail:changed`), which cannot be a retrying assertion; acceptable, deserves a comment. `setTimeout(resolve, 2)` inside `page.evaluate` at `composer.spec.ts:1571` spaces `updated_at` for ordering (benign). Everything else uses `expect`/`expect.poll`.
- CSS-class selection: `reading.spec.ts:274-275` `.gmail_signature`/`.gmail_quote` (Gmail structural markers inside the mail frame — content assertions, not app styling); `triage.spec.ts:80` `toHaveClass(/app-thread-exit/)` (redundant with `data-exiting` at :79); `composer.spec.ts:265` `.app-toast-countdown` inside an evaluate although a `toast-countdown` testid exists (:260). No Tailwind-class selectors.
- `test.skip` / `test.fixme` / `.only` / `it.todo`: none in e2e or src; `playwright.config.ts` `forbidOnly: !!process.env.CI`.
- Perf suite grep-inverted out of `verify` (`playwright.config.ts` `grepInvert`), so its assertions never gate merges.
- Test seams (`src/shared/ipc.ts` `TEST_CHANNELS`): focusThread, setSyncState, reloadSeed, deleteThread, delayConversation, delayDraftReopen, delayDraftInlineImage, updateMessageBody, failNextDraftSave, markDraftMirrored, failNextAction, failNextActionAuth, setAttachmentPickerFiles, setUndoSendDelay, failOutbox, remoteDraft, runLifetimeSweep. All torn down in `teardownOwnedResources`.

## 5. Top 10 coverage gaps (prioritized)

1. **T21 label-catalog refresh: unimplemented, zero tests.** Test: poller.test.ts — `syncLabels` invoked once per `runNow` and a throw doesn't fail the cycle (mirror :232/:245); a pure catalog-diff planner unit; e2e — `reloadSeed` with a renamed label → picker shows the new name after a poll tick.
2. **Performance criteria are not in the gate and are under-scaled** (F3 60fps@10k, F3/F6 <50 ms, F4/F6 <16 ms). Test: 10k perf seed; scroll test sampling rAF deltas during wheel scroll (p95 < 16.7 ms); 100-row select+`e` feedback timing; run `@perf` in CI (nightly if not per-PR) with ceilings tightened from measured data (T20 items 1–2).
3. **Reply-during-snooze wake untested (F4).** Test: poller.test.ts — history with an inbound message on a thread → `effects.wakeThread` called (a `newMail` plan already exists at :82); scheduler.test.ts — `wakeThread` returns the pending reminder and fires `onChanged`; e2e — snooze `t-roadmap`, inject an inbound message via a seam, expect the row back with the returned chip.
4. **Bulk scale never exercised.** F4 "Z reverses 100" and F2 "archive 20" are covered at N=3 (`triage.spec.ts:129,335`). Test: on the perf seed, `x` + `Shift+J`×99 → `e` → rows −100 and "100 pending" within budget → `z` → all back; plus an offline relaunch at N=20.
5. **Crash recovery uses graceful quit, not a kill.** :1653 and :395/:291 rely on `boot.relaunch()` → `app.quit()` (`e2e/electron.ts:129`). Test: add `boot.relaunch({ kill: true })` that SIGKILLs Electron and use it in the continuous-typing and queued-row cases; in :1653 also read `window.attn.draft.get(id)` immediately after typing to prove the 5 s checkpoint directly.
6. **`drafts.ts` CRUD has no unit tests despite T14A's promise** (`reopenThreadDraft`, `reopenDraft`, `takeRecoveredDraft`, `listDrafts`, `closeDraft`, `upgradeReplyToReplyAll`). Test (in-memory `openDatabase`, as `spool.test.ts` does): reply + forward on one thread → `reopenThreadDraft` returns newest per slot and flips to composing; `closeDraft` on an empty new draft deletes the row (`count(*)` = 0) vs leaves a `discarding` tombstone when `gmail_draft_id` is set; `listDrafts` excludes empties, newest first.
7. **DRAFT message must not drive thread snippet/last_msg_at (T14B) is unasserted.** Test: e2e — for the "Q3 roadmap review" row assert `thread-snippet` reads "I added the launch milestones." and time 10:12, not the 11:05 draft (`seed-inbox.json:52-65`); or a unit through `persistThread` with an in-memory DB.
8. **Zero-loss invariant asserted by containment, not byte-identity; no `multipart/related` golden.** Test: extend `composer.spec.ts:1064` to compare saved HTML (minus the appended text) against a canonical expected string and assert `<img` survives; add `fixtures/related-inline.eml` to `CASES` in `mime.test.ts`.
9. **T18 e2e auth pause is a 401, not the promised refresh-token failure.** Test: let `attn:test:failNextActionAuth` accept `'invalid_grant'` through the same typed auth-marker path; assert identical reconnect/resume UI, and that a *different*-account sign-in does not resume (unit-only today at `actionReconnect.test.ts:23`).
10. **Offline/online and stage-progression e2e claims are driven by injected state.** F2 criterion 4 and S3's "seeded profile reaching the new stages" run through `attn:test:setSyncState` (`seeded.spec.ts:119`). Test: a `runInboxBackfill` seam against a supplied in-memory provider (as `lifetime-sweep.spec.ts` does for the sweep) asserting the footer walks stages to `done`; and `setOffline(true)` → triage → `setOffline(false)` asserting the executor drains through a seeded provider (the `failNextAction` provider seam already serves snapshots).

## Appendix — e2e inventory (14 files, 113 tests, 4 `@perf` excluded from verify)

**background.spec.ts** — 3 closing the window keeps the app alive until an explicit quit; 23 development and test runs do not register a login item; 31 a --hidden launch is windowless until asked to show
**contact-hygiene.spec.ts** — 5 keeps Spam, Trash, and legacy Chat rows out of mail-derived contacts
**hydration.spec.ts** — 5 opens metadata-only mail immediately and explains the signed-out provider state; 19 keeps the cached snippet readable while offline
**composer.spec.ts** — 215 opens the first-class Drafts view with g d; 220 opens reply and forward from the selected inbox row; 236 validates recipients before queueing a send; 248 queues durably and undo send reopens the intact composer; 291 spools picked and dropped attachments through queue and relaunch, then cleans on discard; 342 rejects an oversized picked attachment without creating a chip; 355 renders coarse attachment upload progress in the global toast; 395 discovers a provider-gated send through the pending readout and Go to Outbox command; 446 surfaces a durable failed send without interrupting the current task; 503 opens the composer, validates chips, autocompletes locally, and saves on Escape; 590 adds links from the toolbar and the registered composer shortcut; 608 preserves comma names and pending recipients while keeping cleanly closed drafts closed; 648 discards an empty draft on close; 658 opens reply, reply-all, and forward drafts from the reader and reuses the reply draft; 748 releases a delayed draft reopen when the reader closes first; 778 keeps a detached draft escapable when its parent thread is missing; 812 discards an untouched reply but keeps one the user typed into; 839 discards an untouched reply that was upgraded to reply-all; 857 keeps the view nav and sync footer while an inline draft is open; 882 restores a bound draft when J reads into its conversation; 909 releases a superseded reopen lease when J leaves before it resolves; 935 marks and opens a Gmail forward draft inline when its parent thread is cached; 1003 preserves a newsletter surface and CID resources in a forward draft; 1064 preserves rich and opaque draft regions while editing elsewhere; 1111 preserves unsupported foreign HTML pasted into a new draft; 1132 spools data images pasted through HTML and saves them as CID parts; 1159 rejects a stale discard without deleting a closed draft image; 1195 hydrates Gmail CID images and imports its signature as editable composer content; 1258 hydrates bracketed percent-encoded CID images inside preserved HTML; 1288 opens and edits a remote plain-text-only draft without losing its body; 1319 does not overwrite typing when CID image hydration finishes late; 1350 keeps the selected draft stable when a refresh reorders the list; 1418 adopts closed remote edits, preserves Bcc, and defers an edit while open; 1482 keeps multiple Gmail reply drafts on one thread distinct across sync cycles; 1515 persists content supplied while creating an id-less draft; 1549 lists every distinct draft after relaunch in newest-first order; 1582 restores the same full-window reader after composing; 1605 recovers a mirrored draft after relaunch without making initial content undoable; 1637 checkpoints a complete recipient while its field remains focused; 1653 checkpoints continuously typed content without waiting for an idle gap; 1669 retries a failed autosave without clearing the dirty checkpoint; 1684 discard removes the local recovery surface; 1698 keeps the caret in a recipient field while a preserved region sits in the body; 1757 restores the collapsed quote on a reply Gmail merged into one document
**html-mail.spec.ts** — 8 sanitizes hostile HTML in a scriptless iframe and preserves plain text mail; 279 loads direct mail images when the sender restricts cross-origin embedding
**lifetime-sweep.spec.ts** — 61 resumes a header-only lifetime sweep across offline relaunch without changing inbox unread
**labels.spec.ts** — 7 searches, applies, and undoes a user label; 52 keeps picker typing isolated and opens it over a conversation; 79 shows existing user-label membership without system labels; 91 wraps picker navigation at both ends and scrolls the highlight into view
**perf.spec.ts** (`@perf`) — 154 renders the list within the CI-safe ceiling; 167 opens mounted conversation content within the CI-safe ceiling; 184 removes triaged rows within the CI-safe ceiling; 197 opens and types in the composer within CI-safe ceilings
**seeded.spec.ts** — 15 renders seeded mail through IPC and the real SQLite store; 45 exposes threading headers and idempotent contact ranking over IPC; 119 shows phased sync progress and keeps error details behind an accessible control; 235 relaunches against persisted seeded data without importing again
**reading.spec.ts** — 6 invalidates viewed conversation data when local mail changes; 30 clears the previous conversation while an uncached thread loads; 47 shows inspectable recipients and collapses plain-text signatures and quotes; 128 shows attachment metadata and explains offline downloads; 172 keeps HTML fallbacks readable and never collapses an all-quote message; 190 collapses sanitized HTML quote and signature blocks behind an expander
**notifications.spec.ts** — 14 focus-thread push selects the requested row and opens its conversation; 28 a notification target survives recreating a closed window; 45 focus-thread safely leaves an open Snoozed conversation before opening Inbox
**snooze.spec.ts** — 6 repairs local reminder state when Gmail rejects a snooze; 30 snoozes from the picker, navigates to Snoozed, and undoes; 63 parses custom times without leaking list shortcuts from the input; 77 navigates picker options with arrows and unsnoozes back to the inbox; 112 undoes reminder changes and archive without losing the original due time; 138 snoozes every selected conversation, not just the focused one; 166 unrelated reader keys disarm a pending go chord; 177 returns a due snooze to the inbox with a returned chip; 193 catches up a snooze that became due while the app was closed
**triage.spec.ts** — 8 archives with auto-advance and undoes durably; 22 self-heals a permanently rejected archive and invalidates its undo; 45 makes an auth-paused action visibly reconnectable; 74 animates a marked-done row before removing it; 90 does not drop rapid archives or an undo during the exit animation; 129 selects a range and archives it as one undoable bulk action; 189 extends disjoint selections without dropping earlier rows; 205 extends a range while the full-window reader is open; 219 keeps the range anchor selected when toggling a row off; 235 shrinks the range when Shift+K walks back over an overshoot; 252 extends from the cursor after the anchor row is deselected; 272 keeps the range anchor on its thread when undo reorders the list; 292 derives bulk star and unread direction from the selected rows; 312 toggles star and unread, then trashes; 335 keeps offline actions across relaunch without reseeding; 348 triages from the reader and advances the open conversation; 361 keeps explicit unread and undo stable while the reader is open; 372 does not run destructive shortcuts with command modifiers; 382 keeps a valid selection after navigating an empty inbox; 398 extends the selection with Shift+Arrow in the list and in the reader
**smoke.spec.ts** — 15 boots the built app with an isolated store and working IPC bridge; 48 prevents a file drop from navigating the sandboxed renderer; 67 shows onboarding instead of mock mail while signed out; 80 leaves the inbox keyboard loop unmounted while signed out; 111 captures signed-out onboarding for visual review; 123 groups the list by age and labels the list-context shortcuts; 148 J/K and arrow keys move list selection without opening a conversation; 169 Enter opens the reader; J/K navigates; boundary K, Back, and Esc restore the list; 276 restores list scroll on reader exit, and follows a cursor moved by J/K; 326 captures the Dispatch inbox for visual review

The unit-test inventory is regenerable with `grep -n "^\s*it(" src/**/*.test.ts` and is not repeated here.
