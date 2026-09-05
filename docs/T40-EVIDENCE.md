# T40 evidence — M4 exit and v1 sign-off

State of the [M4-PLAN T40 exit checklist](M4-PLAN.md#t40-m4-exit-and-v1-sign-off) as of **2026-09-03**,
following the T20-EVIDENCE convention: each box is ticked with its evidence, or held open with what it
still needs. Engineering evidence below comes from the M4 branch (`claude/m4-implementation-6j6of2`,
head `8ace1ab`) in the Claude Code cloud container (Linux 6.18, Node 22.22, Electron 43.3, Xvfb,
hidden windows). A 2026-09-03 rerun on an Apple Silicon Mac supplied the real-vsync performance evidence;
items needing real Gmail, a real LLM provider, or operator credentials are **open** and say so.

## Feature evidence (this milestone)

- [x] **Deterministic notification-focus regression coverage (T32).** `e2e/accounts.spec.ts` covers the
  guarded switch while composing, the completed journey after close, and the made-deterministic
  pull-dies-during-remount case ("a notification click survives a pull that dies during the account
  remount"). The plain-path journey assertion gained load headroom on 2026-08-31 (commit `8ace1ab`)
  after reproducing a slow-runner timeout at the pre-change HEAD. *The real-OS half of this box (login
  and menu-bar toggles, both-OS pause/resume) stays open below.*
- [ ] **Settings with two accounts on real OSes** — reorder/relaunch/sign-out flows have e2e coverage
  (`settings.spec.ts`, `accounts.spec.ts`); the real-OS evidence for login items, the macOS menu-bar
  icon, and trayless pause/resume is open (operator, both OSes).
- [ ] **Historical sync limit against real Gmail** — capped/custom/All-mail transitions, relaunch
  resume, and lowering-deletes-nothing are e2e-covered (`settings.spec.ts`, `lifetime-sweep.spec.ts`);
  the real-Gmail observation with disk/time expectations for All mail is open (operator).
- [ ] **Attn footer end to end** — placement, editability, relaunch, undo send, and the AI-drafting
  interplay (generation/undo/regeneration keep exactly one footer) are e2e-covered
  (`settings.spec.ts`, `composer.spec.ts`, `ai-draft.spec.ts`); the real-Gmail round trip is open
  (operator).
- [ ] **Real-Gmail follow-up run** — the full local matrix is covered (`follow-up.spec.ts`: creation at
  the sent commit, reply cancellation through the production history cycle, the originating send never
  canceling, snooze coexistence across relaunch; `followUps.test.ts` for the origin/tie/replay rules);
  the dogfood run with a real reply and a real expiry is open (operator).
- [ ] **AI drafting against one real provider** — the fake-provider journeys are e2e-covered
  (`ai.spec.ts`, `ai-draft.spec.ts`, incl. zero-traffic-when-disabled across relaunch); the
  real-provider run (any provider, local Ollama counts) with a traffic check after disable is open
  (operator).
- [ ] **Autocomplete against a real provider** — consent separation, bounded payload, Tab/Esc/undo,
  no-persistence, and silent failure are covered (`ai-autocomplete.spec.ts`,
  `autocompleteController.test.ts`, `autocompleteExcerpt.test.ts`, manager rate-limit tests); the
  real-provider latency/request-count recording is open (operator).
- [ ] **Windows numeric badge visual check** — unit coverage pins the PNG, zero-clears behavior, and the
  cross-platform enable setting; the on-Windows badge/clear look and a macOS disable/enable check are open
  (operator).
- [ ] **Signed/notarized install + schema-migrating update on both OSes** — the migration-aware updater,
  its install-time re-validation, atomic v21-to-current migration coverage, and
  `package:verify --release` are automated; `update.spec.ts` proves the harness build constructs no
  updater. The populated-profile update on real OSes needs operator credentials and a published test
  feed (open).
- [ ] **Credential-free personal packaging on both OSes** — verified on Linux here (`package:dir`:
  personal metadata generated and packaged, verifier passes with zero credentials, `--release`
  refuses the personal artifact); the macOS and Windows runs are open (operator).
- [x] **Every new screenshot artifact inspected** (2026-08-31, this container's fresh e2e output):
  `settings.png`, `settings-sync.png`, `cheat-sheet.png` (including the T37A Tab/Esc note),
  `composer-attn-signature.png`, `composer-attn-signature-light.png`, `remote-images-blocked.png`,
  `snippet-manager.png`, `ai-draft.png`, `ai-autocomplete.png`, `ai-autocomplete-light.png` — all
  render as intended in their themes, no selection highlights.

## Inherited manual items (all open; all operator)

- [ ] M1's real-OS notification click-through smoke.
- [ ] M2's real-Gmail bootstrap, exactly-once, and hydration observations.
- [ ] M2's one-week sole-client dogfood run, extended to snippets, follow-ups, the footer, AI
  drafting, and autocomplete.
- [ ] M5's A7 real-Gmail two-account dogfood observation.

## Bookkeeping

- [x] SPEC §8 status paragraph updated with the M4 entry; the M4 bullet carries its shipped/open note.
- [x] Release workflow, feed stamping, and the Settings → About update surface landed 2026-09-04;
  `e2e/update.spec.ts` covers About under the harness (development build, no check button, a
  staged ready state offering the restart) and `scripts/stamp-update-feed.test.mjs` the stamp.
- [x] KNOWN-ISSUES re-verified 2026-09-03: auth-refresh and real-vsync perf gaps closed by evidence.
  REF-1 closed on 2026-09-03 by separating Inbox's behavior coordination from its layout; both exported
  mail-surface components are now below the ~350-line bar.
- [x] **Perf suites, recorded runs (2026-08-31 cloud container; 2026-09-03 Apple Silicon Mac):**
  - `npm run e2e:perf:scale` (40k-thread bounded reads): **passed**.
  - `npm run e2e:perf` (10k + 1k two-account profile): **14 of 18 passed.** Every non-paint budget
    holds with all M4 features enabled — warm account switch p95 **42ms** (F18 budget 100ms), warm
    split switch p95 12ms, composer open p95 11ms, keystroke **mutation** medians 4–5ms including the
    T37A repeat with autocomplete enabled against a delayed fake provider, 100-conversation paging and
    memory-adjacent reads green. The four failures are exclusively frame-timed metrics
    (scroll-frame pacing, search-keystroke-to-results at a constant ~1,013ms, one split-switch p95
    outlier, composer paint-delta): this container paints hidden windows at ~1Hz, reproduced
    unchanged at the pre-AI T35 commit.
  - `npm run e2e:perf` on the Mac: **18 of 18 passed**. Frame-timed p95 values were scroll frame
    **9ms**, search keystroke-to-results **41ms**, composer keystroke paint **9ms**, and paint delta
    **6ms**. The previously suspect warm split switch measured **3ms p95** (cold **30ms**), and the
    two-account split switches measured **33ms** and **33ms p95**, all inside their existing ceilings.
  - The hosted-Linux ceiling decision was recorded on 2026-09-03 after the same built-app account-switch
    path varied independently of product code: the post-merge `main` run measured split-account p95s of
    **126ms/109ms** and ordinary account switching at **243ms**, while the next PR measured the ordinary
    path at **68ms** but one split direction at **157ms**. Hosted Linux now uses a **300ms regression-smoke
    ceiling** for account switching. Developer hardware retains the normative F18 **100ms** gate, already
    evidenced above at 33ms in both split directions.

## Done when

The v1 tag is cut from a green `npm run verify` on `main` once the open boxes above are ticked or
struck with reasons. The T39 operator prerequisites (Apple Developer ID + notarytool credentials, the
Windows signing certificate, and the release-feed repository decision — a public repository, recorded
as the `ATTN_RELEASE_FEED` repository variable) gate the signed-update boxes. The publishing workflow
stamps the target and minimum migratable schema into each release feed entry
(`.github/workflows/release.yml`, [RELEASE.md](RELEASE.md)); running it is the first step of the
signed-update box.
