# T40 evidence — M4 exit and v1 sign-off

State of the [M4-PLAN T40 exit checklist](M4-PLAN.md#t40-m4-exit-and-v1-sign-off) as of **2026-08-31**,
following the T20-EVIDENCE convention: each box is ticked with its evidence, or held open with what it
still needs. Engineering evidence below comes from the M4 branch (`claude/m4-implementation-6j6of2`,
head `8ace1ab`) in the Claude Code cloud container (Linux 6.18, Node 22.22, Electron 43.3, Xvfb,
hidden windows); items needing real hardware, real Gmail, a real LLM provider, or operator credentials
are **open** and say so.

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
- [ ] **Windows numeric badge visual check** — unit matrix shipped with T38; the on-Windows look at
  counts 1, 42, 150, 0 is open (operator).
- [ ] **Signed/notarized install + same-schema update on both OSes** — the schema-gated updater, its
  install-time re-validation, and `package:verify --release` shipped with T39 (21 unit tests;
  `update.spec.ts` proves the harness build constructs no updater); the populated-profile update and
  incompatible-schema rejection on real OSes need the operator credentials and a published test feed
  (open).
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
- [x] KNOWN-ISSUES re-verified 2026-08-31: every entry re-stamped with corrected anchors (GAP-2
  through GAP-6, REF-1/3/4) or newly recorded (GAP-7); none closed silently.
- [~] **Perf suites, recorded run (2026-08-31, cloud container above):**
  - `npm run e2e:perf:scale` (40k-thread bounded reads): **passed**.
  - `npm run e2e:perf` (10k + 1k two-account profile): **14 of 18 passed.** Every non-paint budget
    holds with all M4 features enabled — warm account switch p95 **42ms** (F18 budget 100ms), warm
    split switch p95 12ms, composer open p95 11ms, keystroke **mutation** medians 4–5ms including the
    T37A repeat with autocomplete enabled against a delayed fake provider, 100-conversation paging and
    memory-adjacent reads green. The four failures are exclusively frame-timed metrics
    (scroll-frame pacing, search-keystroke-to-results at a constant ~1,013ms, one split-switch p95
    outlier, composer paint-delta): this container paints hidden windows at ~1Hz, reproduced
    unchanged at the pre-AI T35 commit — KNOWN-ISSUES **GAP-7**. The green-on-release-build,
    frame-timed half of this box needs a machine with real vsync (operator).

## Done when

The v1 tag is cut from a green `npm run verify` on `main` once the open boxes above are ticked or
struck with reasons. The T39 operator prerequisites (Apple Developer ID + notarytool credentials, the
Windows signing certificate, the release-feed repository decision — deferred into
`ATTN_RELEASE_FEED`/`ATTN_DISTRIBUTION_MODE` at package time — and the publishing workflow that stamps
`requiredSchemaVersion` into each release feed entry) gate the signed-update boxes.
