# Test suite audit, 2026-09-02

This audit covers test selection, runtime, duplicate coverage, disabled tests, and the CI command graph at `583f273` plus this change. It is not a branch-coverage measurement. Timings come from local macOS runs on Node 24.14.0 and Electron 43.3.0. CI uses Node 22 on Linux.

## Results

All requested suites pass after the fix. Profiling identified unnecessary account-switch count recomputation and fixture-import cleanup in the warm-performance measurement. The product fix and corrected setup retain the original 100 ms limit. Ten independent split-account runs also pass.

| Suite | Before | After | Result |
| --- | --- | --- | --- |
| Unit | 1,196 tests in 138 files, 3.66 s wall time | 1,196 tests in 138 files, 3.68 s Vitest duration | Passed |
| Regular Electron e2e | 293 tests in 39 files, 397.80 s wall time | 284 tests in 38 files, 6.6 min reported by Playwright | Passed |
| Smoke subset | 10 tests, 6.1 s test time | 6 tests within the full e2e run | Passed |
| Standard performance | 18 tests, 17 passed and 1 failed | 18 passed; 122.15 s wall time | Passed |
| Scale performance | 1 test, 31.6 s test time | 1 passed, 30.1 s reported by Playwright; 30.56 s wall time | Passed |

The final `npm run verify` passed in 400.16 seconds, including typechecks, lint, units, build, and regular e2e. An earlier post-pruning run took 384.82 seconds, with regular e2e reporting 6.3 minutes; the final run reported 6.6 minutes. These observations do not establish an overall speedup. The focused timer tests below show reduced waits, but no controlled benchmark isolates the pruning change. The baseline unit timing includes command overhead; the final unit duration is Vitest's own measurement.

The full standard performance run measured split-account switching at 32 ms p95 in both directions. The scale run measured medians of 1.51 ms for mailbox counts, 0.26 ms for All Mail paging, and 66.16 ms for common-term search. Final logs are `.audit/verify-account-switch-fix.log`, `.audit/perf-account-switch-fix.log`, and `.audit/perf-scale-account-switch-fix.log`.

The baseline standard performance failure was test setup, not a failed timing budget. A center click placed the caret inside the protected Attn footer. Autocomplete correctly refused to suggest there. `e2e/perf.spec.ts` now clicks the authored body line. The focused test then passed, including autocomplete acceptance at 8 ms.

### Split-account performance root cause and fix

The initial post-audit standard run passed the repaired composer test but measured one warm split-account switch at 126.4 ms, above the existing 100 ms ceiling. The other samples in that direction were 56–60 ms. Five repeated runs of the unchanged test produced three failures at 122–129.5 ms. A second five-run diagnostic with Playwright tracing disabled produced four failures at 116.7–123.7 ms. Trace recording alone therefore does not explain the misses.

Follow-up profiling found two contributors. First, `persistActiveAccount()` writes the selected account to SQLite. That increments `total_changes()`, which `mailSummary()` uses to detect unannounced writes. The next badge update therefore recomputed split totals for both accounts, even though no mail changed. The CPU profile pins the work to `countBySplit` through `broadcastBadge`. Instrumented account flips took 25 to 27 ms.

Second, importing the 11,000-thread fixture left garbage collection and native cleanup running into the first measured switches. One 115.6 ms switch included a 20.7 ms empty-split preload, a 25.1 ms account flip, and two utility tasks containing garbage collection that took 24.2 and 33.2 ms. With only the cache fix, an instrumented switch still reached 108.9 ms while a GC-containing utility task took 72.5 ms. The instrumentation timings are diagnostic, not benchmark results.

The product fix preserves only summaries whose revision matched the database immediately before the synchronous account-selection write. Summaries made stale by earlier mail writes remain stale. Other writes, triage, split edits, and in-flight foreground provider work retain their existing invalidation rules. Account selection is still persisted before the switch completes. No schema change is needed.

The test now reopens the same seeded database before warmups. This measures cached-mail switching in a process that did not bulk-import the fixture. It does not suppress garbage collection during measured interactions. The 100 ms ceiling, five samples per direction, and zero-retry policy are unchanged. Ten independent runs, covering 100 measured switches, passed with reported p95 values from 31 to 33 ms.

The regression tests prove cache reuse and silent-write invalidation. Removing the preservation loop makes two assertions fail. Removing only the pre-write revision guard makes the silent-mail-write test fail with stale counts. Both deliberate mutations were restored before final verification. Temporary IPC and CPU probes were also removed from production source.

Empty-split preloads still perform account-wide reads. This patch does not change their scheduling or SQL; they are visible in the profile but no longer combine with count recomputation and fixture cleanup in the warm benchmark.

Reproduce after building and generating the performance fixtures:

```sh
npm run e2e:perf
node scripts/run-e2e.mjs --perf e2e/perf.spec.ts --grep 'switches split inboxes' --repeat-each=5
```

Failure evidence: `.audit/perf-final.log`, `.audit/split-switch-repeat.log`, `.audit/split-switch-no-trace.log`, and the preserved first failure trace in `.audit/split-switch-failure/`.

Cause and fix evidence: `.audit/account-switch-profile-before.json`, `.audit/account-switch-profile-before-trace.json`, `.audit/account-switch-profile-cpu.cpuprofile`, `.audit/account-switch-profile-cache-fix.json`, `.audit/account-switch-profile-cache-fix-trace.json`, `.audit/account-cache-negative.log`, `.audit/account-cache-stale-guard-negative.log`, and `.audit/split-switch-fixed-repeat.log`. The local profiler and saved instrumentation patch are diagnostic artifacts, not shipped code.

## Removed duplicate Electron launches

Nine standalone tests were removed. The screenshot artifacts remain available. No performance sample count, timing ceiling, security check, persistence check, or account-isolation check was relaxed.

| Removed standalone case | Coverage that remains |
| --- | --- |
| Signed-out keyboard-loop test | The same assertions now run in the onboarding smoke test. |
| Signed-out screenshot test | The onboarding smoke test captures and attaches `login.png`. |
| Inbox screenshot test | The date-group and footer smoke test captures and attaches `inbox.png`. |
| List J/K and arrow navigation test | The same navigation and boundary assertions now precede the reader smoke flow. |
| Light inbox and reader screenshot test | The functional theme test captures and attaches `inbox-light.png` and `reading-light.png`. |
| One-line `G D` composer navigation test | `mailbox-navigation.spec.ts` checks every G chord, including Drafts. Composer lifecycle tests also use `goToDrafts`. |
| Development login-item e2e test | `src/main/background.test.ts` calls the production `applyLoginItemSetting` function and proves that a development adapter never registers a login item. |
| Calendar-year grouping e2e test and its private fixture | `src/renderer/src/dateGroup.test.ts` checks current and prior calendar years. Smoke still checks rendered group headers through the real list. |
| Modified destructive-key e2e test | `src/renderer/src/commands.test.ts` registers Archive and Unread, proves bare keys match, and rejects Meta+E, Control+U, and Alt+E through the production matcher. |

## Faster timer tests

| Case | Baseline | Focused result | Preserved check |
| --- | --- | --- | --- |
| G-chord dismissal routes | 4.5 s | 0.7 s | The production chord timer expires after the renderer clock advances. |
| Continuous-typing checkpoint | 10.4 s | 1.6 s | Repeated edits reset idle saving while the five-second checkpoint persists the exact revision to SQLite. Relaunch recovers the full text. |

The checkpoint clock pauses before the trailing idle save can run. A negative test temporarily changed `MAX_CHECKPOINT_MS` from 5,000 to 50,000. The test failed at `ComposerPage.expectSaved`, as expected. The production value was restored and the app rebuilt. The local proof is in `.audit/checkpoint-mutant.log`.

## Retained coverage

The unit suite contains 83 main-process files, 42 renderer files, 12 shared files, and one preload file. Its 3.66-second runtime does not justify deleting edge-case coverage. All 1,196 unit tests remain.

The regular e2e inventory below reflects `npx playwright test --list` after pruning. Every retained file still covers browser behavior, process integration, persistence, or a feature path not established by a pure unit test.

| File | Tests | Coverage retained |
| --- | ---: | --- |
| `accountRestore.spec.ts` | 9 | Account round trips, paged selection, and background inserts or removals |
| `accounts.spec.ts` | 28 | Roster switching, guarded drafts, removal, notifications, and account isolation |
| `ai-autocomplete.spec.ts` | 7 | Consent, transient previews, acceptance, cancellation, protected regions, and layout |
| `ai-draft.spec.ts` | 11 | Streaming, undo, refinement, cancellation races, and message-scoped context |
| `ai.spec.ts` | 3 | AI settings, key storage, consent, and persistence |
| `background.spec.ts` | 3 | Window close, native title-bar geometry, and hidden launch |
| `chord-guide.spec.ts` | 5 | Contextual footer, chord lifetime, overlay cancellation, and overflow |
| `command-palette.spec.ts` | 6 | Context dispatch, focus containment, iframe routing, draft protection, and usage persistence |
| `composer.spec.ts` | 59 | Draft lifecycle, send and undo, attachments, rich content, signatures, autosave, and recovery |
| `contact-hygiene.spec.ts` | 1 | Junk and legacy Chat exclusion through the real store |
| `existence-sweep.spec.ts` | 1 | Ghost removal only after complete account listings |
| `follow-up.spec.ts` | 5 | Due returns, reply cancellation, snooze coexistence, and toolbar focus |
| `html-mail.spec.ts` | 2 | Hostile HTML, scriptless frames, keyboard forwarding, and image loading |
| `hydration.spec.ts` | 2 | Metadata-only reads and offline cached content |
| `inbox-zero.spec.ts` | 5 | Split counts, account readiness, incomplete bodies, and recovery |
| `junk-reply.spec.ts` | 1 | Trash-projected reply source |
| `labels.spec.ts` | 6 | Apply and undo, bulk targets, catalog refresh, and picker navigation |
| `lifetime-sweep.spec.ts` | 1 | Header-only cursor recovery across relaunch |
| `mail-layout.spec.ts` | 4 | Sender canvases, native backgrounds, and Apple Mail content in both themes |
| `mailbox-navigation.spec.ts` | 8 | Chords, pointer routes, sidebar state, label views, and per-view restoration |
| `message-labels.spec.ts` | 1 | Mixed-label thread membership and hidden Trash bodies |
| `message-replies.spec.ts` | 7 | Per-message replies, draft ownership, undo send, and revealed Trash |
| `mixed-mail.spec.ts` | 2 | Native replies above rich history in both themes |
| `move.spec.ts` | 9 | Bulk moves, exclusive junk transitions, search exits, and snooze restoration |
| `notifications.spec.ts` | 3 | Focus routing and closed-window recovery |
| `reading.spec.ts` | 8 | Message controls, invalidation, recipients, attachments, links, and collapsing |
| `remote-images.spec.ts` | 4 | Request blocking, exceptions, live settings, composer images, and SVG |
| `search.spec.ts` | 17 | Local and Gmail search, caching, projections, selection, and optimistic updates |
| `seeded.spec.ts` | 4 | Real SQLite and IPC, headers, contacts, sync status, and seed durability |
| `settings.spec.ts` | 12 | Settings routes, persistence, reorder races, sync limits, and Attn footer lifecycle |
| `smoke.spec.ts` | 6 | Isolated boot, navigation blocking, onboarding, keyboard loop, reader, and scroll |
| `snippets.spec.ts` | 4 | CRUD, persistence, insertion, cursor placement, and one-step undo |
| `snooze.spec.ts` | 9 | Recovery, parsing, bulk actions, undo, due returns, and relaunch catch-up |
| `splits.spec.ts` | 4 | Classification, selection, rule editing, importance, and notification races |
| `theme.spec.ts` | 2 | OS preference, persistence, sender colors, and original rendering |
| `triage.spec.ts` | 19 | Optimistic actions, recovery, animation, selection, bulk behavior, and durability |
| `update.spec.ts` | 2 | Seeded updater isolation and mount-time announcements |
| `utility-process.spec.ts` | 4 | Crash recovery, durable cursors, FTS backfill, and crash-loop reporting |

## Performance and gate coverage

`npm run verify` checks all three TypeScript projects, Biome, unit tests, the production build, and regular e2e tests. It excludes `@perf` tests. The GitHub workflow runs the standard performance suite as a separate job. The 40,000-thread scale suite remains opt-in.

The standard performance suite retains all 18 tests. It covers list render, 100-row paging, account and split switching, scroll pacing, memory, FTS, 50,000-message search, conversation open, palette timing, mailbox switching, refresh, selection visibility, triage, bulk undo, and composer input. The scale test retains five samples each for mailbox counts, All Mail paging, and common-term search.

No `test.only`, `test.skip`, `test.fixme`, `it.todo`, or equivalent focused or disabled test declarations were found in the source test inventory. Playwright keeps one worker and fresh per-test app profiles. Regular CI runs allow one retry, while performance tests explicitly allow none. Renderer console errors still fail the suite.

The remaining runtime comes mainly from isolated Electron launches, real SQLite setup, and persistence or race scenarios. Pruning duplicated tests saves seconds, not minutes. A larger reduction would require a separate design for profile reuse or a smaller per-change gate, with explicit isolation and coverage tradeoffs.

## Limits

These results cover the local macOS environment. They do not replace Linux CI, Windows packaging, or real-Gmail manual checks. OAuth and Gmail are intentionally absent from seeded e2e tests. Screenshot files are review artifacts, not pixel-diff assertions. This change does not alter that contract.

Inventory commands are `npm run test:unit`, `npx playwright test --list`, `npm run e2e:perf`, and `npm run e2e:perf:scale`. Local run logs and the decision trail are in `.audit/` and are not intended for commit. No workspace `agent-transcripts/` directory was available; the independent review used the saved logs, traces, and current diff.
