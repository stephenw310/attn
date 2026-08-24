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
