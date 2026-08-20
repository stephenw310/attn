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
renderer refresh events coalesce behind one in-flight local snapshot read. Selection-follow scrolling,
full-snapshot refresh, and 100-thread bulk archive/undo are covered in the 10k run.

Follow-up review-fix run on 2026-08-20 (`npm run e2e:perf`, hidden macOS arm64 app): all seven cases passed.
The new full local snapshot refresh measured 30 ms median / 33 ms p95; list render measured 337 ms median /
445 ms p95, scroll pacing 8 ms median / 9 ms p95, and application-owned memory 306 MB.

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

Run a fresh profile against a typical long-lived mailbox and retain the `[sync:metric]` log. Do not record the
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

- [ ] Attn used as the only mail client for seven consecutive days; friction list filed for M3.
- [ ] Force-quit draft recovery and offline relaunch.
- [ ] Undo-send at multiple delays; forced crashes around remote create/send; zero duplicates.
- [ ] Incoming and outgoing attachment round-trips, including inline images.
- [ ] Signed-in metadata-only body hydration, persistence, and connectivity retry.
- [ ] Real-OS notification click opens the intended thread.
