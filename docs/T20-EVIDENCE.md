# T20 hardening evidence

This is the evidence ledger for [M2 T20](M2-PLAN.md#t20--daily-drivable-hardening-and-m2-sign-off).
Automated measurements belong here with their environment and command; real-account and dogfood observations
remain explicitly open until a maintainer records them.

## Automated 10k and composer profile — 2026-08-19

Command: `npm run e2e:perf:only -- --visible`

Environment: macOS 26.5.2 arm64, Node 24.14.0, Electron 43.3.0, built production app, visible window. Five
samples are used for repeated interaction metrics. These local numbers are evidence, while the checked-in
ceilings remain the regression gate on every pull request.

| Metric | Result | Checked-in ceiling/budget |
|---|---:|---:|
| Navigation start → first readable 10k window | 320 ms median / 331 ms p95 | 2,000 ms CI ceiling |
| Scrolling `requestAnimationFrame` interval | 8 ms median / 10 ms p95 | <20 ms p95; SPEC target 60 fps |
| Application-owned steady-state memory | 309 MB | <500 MB |
| Cached conversation open | 1 ms median / 3 ms p95 | <50 ms |
| Single-thread triage feedback | 1 ms median / 1 ms p95 | <16 ms |
| 100-thread archive feedback + undo | 2 ms | <16 ms |
| Composer open | 1 ms median / 3 ms p95; warmups 6/3 ms | <50 ms |
| Composer keystroke → editor mutation | 1 ms median / 2 ms p95 | <8 ms median guardrail |
| Composer keystroke → next paint | 5 ms median / 8 ms p95 | <16 ms SPEC budget |

The memory number is main-process private memory (291 MB, including SQLite/native allocations) plus renderer
JS heap (17 MB; rounded components do not sum exactly). Summed macOS working-set figures are not used because
Chromium reports shared Electron pages in every process, which double-counted this run at more than 1.6 GB.
The same test independently requires fewer than 100 mounted thread rows, bounding the renderer's native DOM
footprint.

Decision: Inbox and Snoozed queries now return at most 10,000 rows, and the renderer uses fixed-height
windowing at 500 rows or more with twelve-row overscan. The old 300-row product cap and perf-only override are
removed. Each list is returned by one static SQL statement rather than a 10,000-placeholder label query, and
renderer refresh events coalesce behind one in-flight local snapshot read. Full-snapshot refresh and
100-thread bulk archive/undo are timed in the 10k run; selection-follow scrolling is asserted there as
geometry rather than latency, because its failure mode is a fixed layout offset that no timing budget sees.
That case walks the keyboard selection past the fold and back to the first row, requiring the selected row to
stay inside the list viewport and to sit against the bottom edge it was scrolled to. The virtual sizer is
measured against the list itself: `offsetTop` resolves to `<body>`, since the list element is statically
positioned, which would fold the header height into every follow scroll.

Follow-up review-fix run on 2026-08-20 (`npm run e2e:perf`, hidden macOS arm64 app): all seven cases passed.
The new full local snapshot refresh measured 30 ms median / 33 ms p95; list render measured 337 ms median /
445 ms p95, scroll pacing 8 ms median / 9 ms p95, and application-owned memory 306 MB.

## S1 utility-boundary profile — 2026-08-22

Command: `npm run e2e:perf`, hidden macOS arm64 app. Environment: macOS 26.5.2, Node 24.14.0,
Electron 43.3.0. All nine cases passed after SQLite and the service workers moved into the utility process.

| Metric | Result | Budget |
|---|---:|---:|
| Cached conversation open | 1 ms median / 5 ms p95 | <50 ms |
| Full local snapshot refresh | 34 ms median / 37 ms p95 | 2,000 ms CI ceiling |
| Scrolling `requestAnimationFrame` interval | 8 ms median / 9 ms p95 | <20 ms p95 |
| Single-thread triage feedback | 0 ms p95 | <16 ms |
| 100-thread archive feedback + undo | 0 ms | <16 ms |
| Composer open | 3 ms median / 3 ms p95 | <50 ms |
| Composer keystroke → next paint | 4 ms median / 10 ms p95 | <16 ms |
| Application-owned steady-state memory | 130 MB | <500 MB |

The memory gate now includes main private memory, utility V8 heap and external allocations, the configured
SQLite cache ceiling, and renderer JS heap. It records utility RSS separately for diagnostics but excludes it
from the app-owned sum on macOS: the Electron Plugin helper maps 976 MB of shared framework pages while its
live heap, external data, and SQLite cache ceiling total 28 MB. Counting those shared mappings as private
would report the same Electron framework once per process.

## T23 FTS5 index profile — 2026-08-23

Command: `npm run e2e:perf`, hidden macOS arm64 app. Environment: macOS 26.5.2, Node 24.14.0,
Electron 43.3.0, SQLite 3.53.4. All eleven cases passed with the FTS5 message index maintained on every
write path and the 10,000-message profile indexed at seed time. These numbers are the requested input to
the open pathological-mailbox question (M3-PLAN §"Open questions"): scaled linearly they suggest roughly
130 MB of index and comfortably sub-100 ms queries at 250k messages, but scaling must be measured, not
assumed, once a real large mailbox is captured under E7.

| Metric | Result | Budget |
|---|---:|---:|
| On-disk index size (`dbstat`, all `message_fts` shadow tables + map) at 10k messages | 5.3 MB (5,509,120 bytes) | recorded, no gate |
| Of which the `prefix='2 3'` option: measured on the same corpus, optimized tables | +1.4 MB (+58% over a no-prefix build) | recorded, no gate |
| FTS query latency, all shapes pooled (100 samples, measured in-utility) | 4 ms median / 5 ms p95 | <100 ms CI ceiling |
| `performance` — one term matching all 10,000 messages | 3.8 ms p95 | — |
| `perf*` — prefix-index path matching all messages | 4.7 ms p95 | — |
| `"performance thread 9999"` — phrase, one thread | 0.1 ms p95 | — |
| `sender42` — narrow sender term, one thread | 0.0 ms p95 | — |
| Application-owned steady-state memory with the index present | 130 MB | <500 MB |

The latency samples time `searchMessageIndex` (thread-ranked `MIN(rank)` aggregation over the
`message_fts_map` join, LIMIT 50) inside the utility process via `attn:test:searchIndexStats`, so IPC
round-trip cost is excluded — T24 owns the end-to-end keystroke budget. Steady-state memory is unchanged
from the S1 run: the index lives on disk inside the same SQLite cache budget.

## T24 end-to-end local search profile — 2026-08-25

Command: `npm run e2e:perf:only -- --grep "renders local search results within budget"`, hidden macOS arm64
app. The generator created 10,000 threads containing 50,000 messages, and the production renderer submitted
20 distinct exact-sender queries through the normal `/` search field.

| Metric | Result | Budget |
|---|---:|---:|
| Search input mutation → completed result render | 74 ms median / 76 ms p95 | <100 ms p95 |

This measurement includes the 25 ms typing debounce, renderer-to-utility IPC, the combined FTS5 and SQL
operator query, and React rendering. The test waits for both the completed-query marker and the one-row result,
so an older response or a pending frame cannot satisfy the sample.

## Synthetic large-mailbox probe — 2026-08-29

**Synthetic, not E7.** A throwaway probe generated stores against the current schema and called the production
`countSystemMailboxes`, `countInboxUnread`, `listMailboxThreads`, and `searchThreads` over them. It answers how
the query layer scales with store size; it does not replace E7, which measures real Gmail bootstrap timing and
quota behavior. The probe files were deleted after the run.

Environment: macOS arm64, Node 24.14.0, better-sqlite3 outside Electron, file-backed SQLite reopened before the
first read of each shape. Corpus: 2.5 messages per thread, ~200-byte plain-text bodies, 2% of threads in Inbox,
10% Sent, 1% each Starred/Spam/Trash. **Real mail is heavier on every axis that matters here** — bodies are
kilobytes not hundreds of bytes, and `searchCoverage` reads body columns — so these numbers are optimistic.

| messages | threads | on disk | counts cold / warm | All Mail page 1 | rare term | 1% term | 30% term | every-message term | `is:unread` |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 50,000 | 20,000 | 0.08 GB | 19 / 17 ms | 14 ms | 20 ms | 24 ms | 46 ms | 87 ms | 39 ms |
| 250,000 | 100,000 | 0.37 GB | 106 / 107 ms | 92 ms | 108 ms | 133 ms | 274 ms | 524 ms | 228 ms |
| 1,000,000 | 400,000 | 1.48 GB | 1,094 / 484 ms | 395 ms | 884 ms | 512 ms | 1,054 ms | 2,013 ms | 901 ms |
| 2,000,000 | 800,000 | 2.96 GB | 1,884 / 948 ms | 770 ms | 1,738 ms | 1,317 ms | 4,331 ms | 5,524 ms | 2,622 ms |

Scaling is linear or worse in every column. §7's budgets are met at the 50,000 messages they are written
against, with roughly 25 ms of headroom on search, and they are gone by 250,000.

**Where the time goes, measured separately at 1,000,000 messages:**

| Component | Cost | Why |
|---|---:|---|
| `searchCoverage` (`sync/fts.ts`) | 414 ms | `COUNT(*)` plus `trim()` over both body columns of every message. Ran on **every** search, i.e. after each 25 ms typing debounce. Since removed: the footer's body count is now a flag read from the backfill cursor, because the fraction never reached its denominator anyway (on-demand bodies are the design, not an unfinished stage) and the remedy it hinted at, server search, is advertised on the line directly above it |
| All Mail count (`countSystemMailboxes`) | 334 ms of the 484 ms warm total | `EXPLAIN QUERY PLAN`: full scan of `threads` with three correlated subqueries per row |
| Search candidate CTE (`db/search.ts`) | ~100 ms for a 1% term, ~1.6 s for an every-message term | The CTE has no limit: the outer query orders by `last_msg_at`, not rank, so `LIMIT 100` cannot push into the FTS scan and every matching message is visited |

`countSystemMailboxes` runs on initial load and on every `mail:changed` refresh. better-sqlite3 is synchronous
and the utility process owns one connection, so this is not a slow query queued behind others: it stalls that
process's event loop and every other renderer read waits it out. The initial load is one `Promise.all` of nine
store calls that serialize in the same process, so cold start pays their sum.

**Derived sync arithmetic at 10,000,000 messages** (≈4,000,000 threads at 2.5 messages each), from the quota
constants rather than a run: background work gets 6,000 − 500 reserved = 5,500 units/minute ÷ 40 per
`threads.get` ≈ **137 threads/minute**, so the lifetime sweep needs ≈20 days of app-open time, realistically one
to three months of wall clock. `LIFETIME_REQUEST_INTERVAL_MS` (600/minute) never binds; quota does. Stage 1 at
foreground priority gets ≈140 threads/minute, so a 12-month Inbox of 100–200k threads completes in 12–24 hours,
with the first readable page in minutes. One expiry recovery listing is ≈40,000 pages × 10 units ≈ 73 minutes,
and Gmail's roughly week-long history retention means several recoveries during a sweep that long.

**After the 2026-08-29 count/coverage changes**, re-measured on the same 1,000,000-message store:

| Metric | Before | After |
|---|---:|---:|
| `countSystemMailboxes`, cold | 1,094 ms | 65 ms |
| `countSystemMailboxes`, warm | 484 ms | 62 ms |
| `countInboxUnread` | 124 ms | 12 ms |
| `countNotificationEnabledUnread` (the production badge) | not measured | 51 ms |
| Search, rare term | 884 ms | 38 ms |
| Search, 1% term | 512 ms | 122 ms |
| Search, 30% term | 1,054 ms | 611 ms |
| Search, every-message term | 2,013 ms | 1,519 ms |
| `is:unread` filter only | 901 ms | 435 ms |
| All Mail list, page 1 | 395 ms | 340 ms |

Three changes produced this: mailbox counts stop at `MAILBOX_COUNT_CAP`, the Inbox counts seek the INBOX label
index instead of scanning `threads` for the visible flag, and the service layer caches counts and search
coverage per mail revision so a typing burst or a refresh burst pays once. Repeat calls inside one revision
now cost nothing, which is the common case: the numbers above are all first calls.

The PR #98 follow-up changes cache invalidation to follow SQLite writes, including background batches that
do not emit `mail:changed`. Search coverage now reads one `sync_state` row on each request and is not cached.
The measurements above predate that correction. Handler regression tests cover silent writes, partial
membership rebuilds, and cursor-only coverage changes.

The perf suite's `local-mail-refresh` measurement never included `getMailboxCounts`, which is how the count
grew into the slowest read in the refresh without failing anything. It now measures both waves in the order the
renderer issues them (10,000-thread profile: 6 ms median, 11 ms p95). A 10,000-thread profile only catches gross
regressions in a query whose cost scales with the store; catching a size-dependent one needs a larger generated
profile.

Two residuals are unchanged by design, and each names the fix that would move it. The All Mail page still
evaluates membership per row, which wants the materialized membership table. Search past a rare term still
visits every matching message, because the candidate CTE cannot push its limit past an outer sort on
`last_msg_at`; bounding that set is a separate change with a product decision attached, since a bounded
candidate set makes a filtered query's result "the most recent matches" rather than exhaustive.

**What this says about the pathological-mailbox question** (M3-PLAN §"Open questions"): the store stays correct
and eventually complete at any size, and the ceiling is not sync completeness but three query shapes. The
extrapolated 10M profile is ~5 s mailbox counts, ~4 s for an All Mail page, and tens of seconds for a
common-word search. Fixing counts, coverage, and the unbounded candidate set is what moves the usable ceiling;
picking a design target without fixing them sets it near 250,000 messages.

## Large-profile perf job and the write regression it found — 2026-08-29

`npm run e2e:perf:scale` generates a 100,000-thread profile and measures the reads that must not scale with the
store. It exists because the 10,000-thread job cannot: the account-wide mailbox count that prompted it measured
584 ms at 800,000 threads and under a millisecond at 10,000, so a budget written against the smaller profile
passes either way.

Building the profile immediately failed, twice, and the second failure was the point of the exercise.

| Threads stored | Import rate, before | after |
|---:|---:|---:|
| 2,000 | 1,055/s | 2,043/s |
| 10,000 | 184/s | 1,949/s |
| 20,000 | 84/s | 1,813/s |

Storing a thread was getting slower the more mail the store already held, so a 100,000-thread import never
finished inside a fifteen-minute timeout. The cause was one query in `removeMissingMessages`
(`sync/persist.ts`), which collects the contacts a vanished message contributed:

```
SEARCH cm USING COVERING INDEX idx_contact_messages_email (account_id=?)   ← every contact row in the account
SEARCH m USING INDEX sqlite_autoindex_messages_1 (account_id=? AND id=?)
```

Written as `FROM contact_messages cm JOIN messages m`, SQLite drove the join from the account's contact rows —
48,200 of them at 20,000 threads — on every single thread write. `INDEXED BY` does not fix it, because it
constrains which index a table uses rather than the order tables are joined; `CROSS JOIN` with `messages` first
does, and SQLite will not reorder it. A unit test now asserts the plan drives from `messages`
(`sync/persist.test.ts`), because the defect was a planner choice rather than a visible mistake in the SQL.

**The original job** (`npm run e2e:perf:scale`, 40,000 threads / 80,000 messages, imported in about
20 seconds, whole run 22 s):

| Read | Healthy, through IPC | Budget | Scanning, measured directly |
|---|---:|---:|---:|
| System mailbox counts | 19 ms | 30 ms | 27 ms (3.4 ms indexed) |
| All Mail first page | 6 ms | 20 ms | 31 ms (0.5 ms indexed) |
| Common-term search | 133 ms | 300 ms | seconds, unbounded candidates |

The budgets sit between the two costs deliberately. This file's first draft used 150 ms for the first two,
which every one of those numbers passes — a budget looser than the regression it guards is decoration. The
profile stops at 40,000 threads because the fixture is parsed whole and the utility process died loading the
74 MB, 100,000-thread version; streaming the fixture would buy a wider margin and is not worth it yet.

This was live before the scale profile existed and nothing caught it: quota admits roughly 137 threads a minute,
so 17 ms per write is invisible during real sync. It shows up wherever writes are local and bulk — seeding a
test profile, and plausibly a long offline catch-up.

## PR #98 rereview measurements, 2026-08-30

The scale job now calls `attn:test:queryPerfStats` to measure production queries inside the utility process.
The former keypress-based invalidation could measure a cached mailbox count before the action completed or
after the renderer refreshed it. Raw query timing removes that race. These measurements exclude IPC and
are not directly comparable to the renderer timings above.

A separate probe imported the same 40,000-thread, 80,000-message seed through `loadSeed` into SQLite and ran
the indexed queries alongside the previous scanning shapes, with five samples each:

| Read | Indexed median | Scanning median | Raw query budget |
|---|---:|---:|---:|
| System mailbox counts | 1.31 ms | 38.26 ms | 15 ms |
| All Mail first page | 0.24 ms | 29.53 ms | 20 ms |

The probe asserts equal counts and 101-row pages, then asserts the indexed reads pass and the scanning
reads exceed their budgets. Common-term search retains its 300 ms budget in the Electron scale job.

Explicit snooze searches also received an indexed path because Gmail cannot search local snooze state.
On a separate synthetic store with 100,000 matching messages and 100 pending snoozes, an account-driven
message join took 1,057 ms median; the reminder-first join took 89 ms. Query-plan regression assertions
require indexed pending-reminder and message-thread lookups before rowid-constrained FTS matching.

## Quota and bootstrap instrumentation

Gmail requests share one per-account weighted scheduler across authentication generations. A short burst bucket
preserves interaction priority, while a rolling-minute ledger prevents burst plus refill from exceeding the
configured limit. Method costs match Google's post-1-May-2026 quota table; the default per-user project limit is
6,000 units/minute and can be overridden with `quota_units_per_minute` in `oauth.config.json`. Priority is send
→ queued action → history polling → foreground read/draft → background indexing; each priority band is FIFO so
cheap later requests cannot starve an older expensive one. Exponential backoff remains the fallback for
server-side 403/429/5xx responses.

The staged backfill now emits `[sync:metric]` JSON records for each completed stage and for the whole bounded
run. Protocol/state fields distinguish first-readable and interactive-ready elapsed time from full completion,
and report stage-listed, stage-fetched, and Gmail-estimated counts separately, alongside cumulative fetched
work, elapsed time, effective threads/minute, and actual quota-scheduler wait time. The lifetime sweep reports
the same cumulative quota wait. Fake-clock unit tests cover the rolling-minute ceiling, weighted pacing,
priority overtaking and FIFO fairness, disposal/cancellation, and stage telemetry.

## Real-Gmail bootstrap run — required before M2 sign-off

**This file owns the tick for every manual sign-off item.** M1-PLAN and M2-PLAN point at the IDs below rather
than restating the items, so a run is recorded once. Cite the ID when you record a result.

**E7 — bootstrap capture.** Run a fresh profile against a typical long-lived mailbox and retain the `[sync:metric]` log. Do not record the
top-bar unread count as sync progress.

| Stage | Listed / fetched / estimate | Elapsed | Fetched threads/min | Quota wait |
|---|---:|---:|---:|---:|
| First readable page | pending | pending | — | pending |
| Inbox metadata / interactive-ready | pending | pending | pending | pending |
| Recent bodies | pending | pending | pending | pending |
| Drafts | pending | pending | pending | pending |
| All mail | pending | pending | pending | pending |
| Spam | pending | pending | pending | pending |
| Trash | pending | pending | pending | pending |
| Reconcile | pending | pending | pending | pending |
| Lifetime headers / full completion | pending | pending | pending | pending |

Also record mailbox message/thread size, configured project quota, whether an address last used outside the
bounded window autocompletes, and that lifetime rows remain header-only until opened.

## One-week dogfood and manual matrix — required before M2 sign-off

Owner/week: **pending**

- [ ] **E1** Attn used as the only mail client for seven consecutive days; friction list filed for M3.
- [ ] **E2** Force-quit draft recovery and offline relaunch.
- [ ] **E3** Undo-send at multiple delays; forced crashes around remote create/send; zero duplicates.
- [ ] **E4** Incoming and outgoing attachment round-trips, including inline images.
- [ ] **E5** Signed-in metadata-only body hydration, persistence, and connectivity retry.
- [ ] **E6** Real-OS notification click opens the intended thread. Owed since M1; see M1-PLAN's T9 box for the
      defect the first run found and the fix awaiting re-test.
- [ ] **E7** Real-Gmail bootstrap capture: the stage table above, filled in from one fresh-profile run. Covers
      both the initial-sync evidence and the lifetime-sweep wall-clock and quota numbers.

E7 is cheapest on the first day of the E1 dogfood week, because it needs a from-scratch backfill anyway.
