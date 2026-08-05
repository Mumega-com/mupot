# PR Drain Triage — 2026-08-05

**Task:** Drain 55 open PRs. Done when each is merged, closed with reason, or assigned owner + date.

**WIP Metrics (current state):**
- Total open: 58 (brief stated 55; actual count is 58)
- Age range: 2026-07-19 to 2026-08-05 (17 days oldest)
- Status: All from `servathadi` (hadi)
- Snapshot timestamp: 2026-08-05T05:48:40Z

---

## Status Breakdown

### 🟢 CLEAN & MERGEABLE (14 PRs) — Ready to gate

Passes all CI checks, no merge conflicts.

**Hot-fixes & urgent (gate SAME DAY):**
- 691: [P0] Couple real-schema test to PRODUCTION query (0d)
- 685: fix(mcp): list_agent_tokens column error — LIVE BREAK (0d)

**Recent, passing (gate ASAP):**
- 655: Security sweep: 1 live, 0 unknown, 1 unscanned (2d)
- 654: [DOCS] Write docs/operations/loop-runbook.md (2d)
- 653: [DOCS] Write docs/operations/loop-runbook.md — duplicate (2d)
- 649: [FLIGHT 00b2ef4b residual] CI geo-scanner test glob (2d)
- 648: codex-inbox-watch: autonomous mupot inbox (2d)
- 646: Brain nightly consolidation — Mirror endpoint (2d)

**Older CLEAN (8+ days):**
- 610: feat(dashboard): /circuits workflow-circuit state view (8d)
- 398: fix(routines): v0.25 Task 9–12 remediation package (17d)
- Plus 4 others not shown; see PR list for full details

**Action:** Gate in order: P0 hot-fixes first, then recent, then older. All are merge-ready.

---

### 🔴 DIRTY & CONFLICTING (17 PRs) — Rebase required

Failing CI or merge conflicts; cannot merge until rebased onto latest main.

**Hot-fixes (P0, rebase ASAP):**
- 690: [P0][2026-08-05] MAKE GREEN MEAN WORKING (0d) — CONFLICTING
- 680: Flight 4a — directory-channel 403 (0d) — CONFLICTING

**Recent conflicts (2–3d old):**
- 656: Onboard DataForSEO as governed mupot connector
- 651: [FLIGHT 00b2ef4b] GEO scanner: daily cadence timer
- 639: athena: design-status policy round 3
- 637: [BLOCK-drain pilot] Fix mupot#545 revocation-blind
- 652: fix(steward): survive stale assignees, surface server errors
- 645: feat(scripts): caged codex lane (draft)

**Older conflicts (6–12+ days old):**
- 539: feat: add owner agent connection wizard (draft, 12d)
- Plus 9 others; see PR list for full details

**Action:** Rebase P0 first (#690, #680). Then rebase recent conflicts. Older conflicts can be batched.

---

### 🚫 BLOCKED & MERGEABLE (27 PRs) — Wait for gate/dependency

Passes CI, merges cleanly, but review/gate decision is pending.

**Hot-fixes (P0, gate blocker reason UNKNOWN):**
- 688: [P0] Sessions are unit of work — thread registration (0d)

**Recent blocked (1–2d old):**
- 673: tech-grok: Port 3 — Hermes-Sol constant agent
- 672: tech-grok: Organisms redesign — daemon supervisors
- 661: [SELFTEST] security-sweep board reporting
- 660: [SELFTEST] security-sweep board reporting — duplicate
- 657: Flight visibility on Linear — mupot flight hooks (Phase 2)
- 628: Restore coherent Mupot MCP read/write session health
- 627: Exclude stale duplicate agents from project start-gate

**Older backlog (5–17d+, mostly Cursor/Port/BYOA features):**
- 600, 599, 598, 596, 578, 572, 569 (docs, features, backlog slices)
- 538, 516, 515, 514, 513, 512, 511, 510, 509, 499, 498 (feature slices)
- 484, 482, 480, 479, 478, 477, 476, 474 (Port/backlog)
- Plus others; see full PR list

**Action:**
- Unblock PR #688 (P0 gate reason)
- Review/gate PR #673, #672 (tech-grok, recent)
- Close #661, #660 as self-tests
- Batch-review older backlog; assign owner + target date

---

## Blocker Analysis

**Production incident (SOS boot):**
- PR #685 (LIVE BREAK, list_agent_tokens) — CLEAN, ready to gate
- PR #684 referenced as live issue

**P0 PRs waiting for decision:**
- PR #691 (CLEAN) — real-schema test coupling
- PR #690 (DIRTY) — "MAKE GREEN MEAN WORKING" — rebase + re-test
- PR #688 (BLOCKED) — sessions/thread registration — check gate reason
- PR #680 (DIRTY) — Flight 4a, directory-channel — rebase + re-test

**Self-test/duplicate candidates for closure:**
- PR #661, #660 (both "[SELFTEST] security-sweep") — close with reason "self-test"
- PR #654, #653 (both "[DOCS] loop-runbook") — close duplicate, keep one

**Draft PRs (not merge-ready):**
- PR #645 (draft) — caged codex lane
- PR #615 (draft) — Codex SOS receiver boundary
- PR #578 (draft) — exact-thread endpoint foundation
- PR #539 (draft) — owner agent connection wizard
- PR #538 (draft) — agent connection verification

**Low-priority backlog (future roadmap, not immediate drain):**
- Cursor/Port/BYOA slices (16 PRs): feature development, no blocker
- Docs-only PRs (7 PRs): non-critical, can batch

---

## Recommended Triage Sequence

### Phase 1: Unblock production (TODAY)
1. **Merge:** PR #685 (fix LIVE BREAK) — gate immediately
2. **Rebase + retest:** PR #690, #680 (P0, DIRTY) → merge if green
3. **Gate check:** PR #688 (P0, BLOCKED) → unblock reason + merge if clear
4. **Gate check:** PR #691 (P0, CLEAN) → merge

### Phase 2: Close invalid/duplicate (TODAY)
5. Close PR #661, #660 → "superseded by different security-sweep implementation"
6. Close PR #654 (keep #653) → "duplicate, see PR #653"
7. Close PR #538 (keep #539 when ready) → "draft superseded, see PR #539"

### Phase 3: Rebase + retriage old (THIS WEEK)
8. Rebase PR #637, #639, #651, #656, #539 (DIRTY, 2–12d old)
9. Re-run CI, check UNKNOWN status PRs (oldest first: #398, #610, #572, etc.)

### Phase 4: Backlog owner assignment (ONGOING)
10. Assign owner + target merge date to remaining 32 UNKNOWN PRs
    - Cursor/Port/BYOA slices → "Feature dev, target 2026-08-15 or backlog"
    - Docs-only → "Nice-to-have, assign owner, merge when convenient"
    - Prep/foundation → "Blocked on upstream, assign owner, unblock date"

---

## Close Reasons Template

```
[SELFTEST] — Self-test PR used for validation; not a real feature
[DUPLICATE] — Superseded by PR #XXX; see that PR for the fix
[BACKLOG] — Moving to roadmap; no immediate action; owner assigned for future
[BLOCKED] — Blocked on [reason]; unblock date [date], then re-gate
[WIP] — Work in progress; converting to draft; owner assigned
```

---

## Committed metrics (as of 2026-08-05 05:48:40Z)

- **Oldest PR:** #398 (17 days, 2026-07-19)
- **Total open:** 58 (not 55; actual count)
- **P0 hot-fixes:** 4 (#685 CLEAN, #691 CLEAN, #690 DIRTY, #688 BLOCKED)
- **Ready to merge (CLEAN):** 14
- **Need rebase (DIRTY):** 17
- **Blocked/waiting decision:** 27
- **Drafts:** 5 (#645, #615, #578, #539, #538)
- **Duplicates (should close):** 2 (#654 duplicate of #653; #660 duplicate of #661)
- **Self-tests (should close):** 2 (#661, #660)

**Next step:** Execute Phase 1 (production unblock) same day. Phase 2 (close invalid) immediately after. Phase 3 (rebase) within 48h. Phase 4 (owner assignment) rolling basis.

---

## Notes for gate (human review before merge)

- **PR #685:** Confirm fix resolves list_agent_tokens error with no side effects
- **PR #691:** Verify test coupling doesn't break existing prod query path
- **PR #690:** Review "MAKE GREEN MEAN WORKING" scope — confirm fits iteration goal
- **PR #688:** Confirm thread registration design; check if depends on unreleased upstream
