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

Sources so far: the 2026-08-16 review of `main` @ #52 ([REVIEW-2026-08-16.md](archive/REVIEW-2026-08-16.md))
and its coverage map ([REVIEW-2026-08-16-coverage.md](archive/REVIEW-2026-08-16-coverage.md)), and the
2026-09-02 review of `main` @ #107 ([REVIEW-2026-09-02.md](REVIEW-2026-09-02.md)). All three are frozen
snapshots kept for their reasoning; the two settled ones now live in [archive/](archive/), while the
2026-09-02 sweep stays in `docs/` because the entries below still cite its open items. This file is the part
that stays current. Each entry cross-references its original review tag, because the review's `S1` and `S2`
security tags collide with the `S1` through `S4` task names in M3-PLAN.

A finding already attached to a planned task stays with that task instead of moving here. The review's B4
pruning edge shipped with M3 S2 on 2026-08-22. M3-PLAN records its coverage and keeps the status current.

Milestone and task status stays in [SPEC.md](SPEC.md) §8 and the plan docs, per [AGENTS.md](../AGENTS.md).
Manual sign-off evidence is ticked in [T20-EVIDENCE.md](T20-EVIDENCE.md). Nothing here is a milestone gate
unless a plan doc says so.

---

## Product defects

None recorded. Every defect the 2026-09-02 review found at high or medium severity was fixed on the branch
that recorded it; the low-severity items stay listed in [REVIEW-2026-09-02.md](REVIEW-2026-09-02.md) §1.

## Test coverage gaps

Each was verified against the acceptance criteria in SPEC §4 and the plan docs' Testing bullets.

## Refactors

None recorded. `Inbox.tsx` and `Composer.tsx` are both below the ~350-line component bar; Inbox's behavior
coordination and layout now live behind separate contracts in `useInboxController` and `InboxLayout`.
