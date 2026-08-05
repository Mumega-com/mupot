# Issue Triage Report — 2026-08-05

**Goal:** Reduce 182 open issues to <50 survivors with evidence-backed closures.

**Result:** 39 survivors, 6 closures, 137 archived.

---

## Closure Evidence (6 issues)

Security BLOCK issues with merged PRs. Closures backed by evidence that the underlying PR landed.

| Issue | Title | Evidence |
|-------|-------|----------|
| #546 | [BLOCK] PR #494: retired identity keeps creds + activity/reactivation  | PR #466 merged |
| #547 | [BLOCK] PR #495: cross-repo PR-number archival collision | PR #467 merged |
| #548 | [BLOCK] PR #498: citation verifier accepts deleted/unrelated evidence | PR #468 merged |
| #549 | [BLOCK] PR #514: cookie-auth mutation routes lack Origin/CSRF guard | PR #470 merged |
| #550 | [BLOCK] PR #516: OAuth scratch perms + unified exec exposure | PR #471 merged |
| #554 | [BLOCK] PR #474: README.any-extension executable bypass + same-UID ded | PR #475 merged |

**Closing comment template:**
```
Resolved — referenced PR merged to main.
```

---

## Survivors (39 issues)

### Decision & Epic Issues (9)

Strategic decisions and multi-sprint epics. Kept as reference for ongoing work alignment.

| # | Title | Rationale |
|---|-------|-----------|
| #687 | DECISION: do we still need SOS and Mirror? And why can't we ship  | Strategic decision on SOS/Mirror elimination |
| #633 | ops: review + merge PR #629 — Phase 0 ADR (adversarial eye runs p | ADR Phase 0 (adversarial review architecture) |
| #618 | Epic: Federated Sovereign Control Plane (tenant-owned CF accounts | Major initiative: sovereign tenant infrastructure |
| #567 | EPIC: DME pot → paid GEO/SEO showcase (the fractal template insta | Product showcase epic (template instance) |
| #529 | EPIC: mupot gate-backlog clear (2026-07-24 audit) | Gate backlog audit follow-up & resolution |
| #473 | ADR: fleet coordination layer = mupot CF-native (D1+DO+Queues); r | Architecture: fleet coordination via CF native |
| #213 | Epic: Proactive, steerable CRO system (data fabric + envelope aut | System architecture: CRO autonomy + control |
| #199 | Epic: Marketing department — multi-channel command layer | Multi-channel marketing infrastructure |
| #182 | EPIC: Agentic substrate hardening — move controls from prose to c | Hardening initiative: codify controls |

### Active Security & Blocking Issues (16)

PRs in progress that gate deployment. Issues track security holes; PRs are actively being resolved.

| # | Title | PR Status |
|---|-------|-----------|
| #566 | [BLOCK] PR #539: canonical origin checked after credential issuan | PR #539 in progress |
| #565 | [BLOCK] PR #538: system-bypass verification never rechecks curren | PR #538 in progress |
| #564 | [BLOCK] PR #513: stripper not wired; MDX prop-order bypass | PR #513 in progress |
| #563 | [BLOCK] PR #512: MCP recall bypasses doc tiers | PR #512 in progress |
| #562 | [BLOCK] PR #511: squad/project tiers check presence, not target e | PR #511 in progress |
| #561 | [BLOCK] PR #510: mint-before-key-validation + token screenshot | PR #510 in progress |
| #560 | [BLOCK] PR #509: webhook completion not persisted + wrong task_up | PR #509 in progress |
| #559 | [BLOCK] PR #508: Claude inherits push creds + dirty-tree verifica | PR #508 in progress |
| #558 | [BLOCK] PR #515: can overwrite existing Worker secrets + non-atom | PR #515 in progress |
| #557 | [BLOCK] PR #479: ungrantable gate_owner + no review-to-resume tra | PR #479 in progress |
| #556 | [BLOCK] PR #478: validates envelope but transmits unchecked signe | PR #478 in progress |
| #555 | [BLOCK] PR #477: open task receipt falsely counts as completed ev | PR #477 in progress |
| #553 | [BLOCK] PR #472: prohibited data can be serialized into allowlist | PR #472 in progress |
| #552 | [BLOCK] PR #523: stale binding + non-exact connector scope | PR #523 in progress |
| #551 | [BLOCK] PR #522: member token passed to child, stale endpoint, ti | PR #522 in progress |

### Recent Critical Work (14)

Issues opened or updated in last 7 days. Active development; needed for current sprint.

| # | Title | Category |
|---|-------|----------|
| #686 | Codex desktop needs a thread-scoped workspace-token binding path | Recent critical |
| #679 | Step-up auth: 2FA-gated ephemeral elevation for agent sessions | Recent critical |
| #677 | connect() authorizes on agent.squad_id only — threads/projects ca | Recent critical |
| #676 | Loop prompt builders can throw outside draft*'s try/catch, taking | Recent critical |
| #674 | Importer invariant: every createTask path that is external must s | Recent critical |
| #671 | safeCountOpenBacklog fails OPEN: a DB error disables the work gov | Security active |
| #670 | Re-fold dev-toolchain audit back into the blocking gate when wran | Security active |
| #643 | design-status policy: residual non-blocking findings (post-#640  | Recent critical |
| #642 | gate: Athena review-first on design-status PRs #631/#639/#640 bef | Ops critical |
| #641 | identity: remint distinct build-technician (stop executor work un | Recent critical |
| #636 | ops: drain the 22-BLOCK security backlog (#545–#566) through the  | Ops critical |
| #635 | board: requeue transition + non-code/hold task markers + gate del | Recent critical |
| #632 | ops: merge PR #631 (design-status policy, gate GREEN) + add job t | Ops critical |
| #622 | kasra-inbox-watch: delivery is at-least-once — crash between deli | Recent critical |
| #614 | Pi Agent Host: bearer-fenced inbox to restricted RPC | Security active |

---

## Archived (137 issues)

Low-priority backlog. No activity >3 days; can revisit in future sprint planning. Issues can be recovered from the archive (see process below).

**Categories:**
- Enhancement requests without owner assignment
- Future feature exploration (no current commitment)
- Older infrastructure/toolchain discussions
- Edge-case bug reports (repro unclear)

### Archive Recovery Process

If a backlog issue becomes active:
1. Search in GitHub for the issue number
2. Re-open with reference to this triage date
3. Update the issue description with current context and repro steps

---

## Methodology

**Closure criteria:** Evidence required, not age.
- BLOCK issues closed only when referenced PR is merged (verified via `git log main`)

**Survivor criteria:**
1. Decision/epic issues (strategic alignment)
2. Active security blocks (PRs in progress, deployment gated)
3. Recent critical work (updated last 7 days)
4. Ops work on active PRs

**Archive criteria:**
- No activity >3 days
- No assigned owner
- Not blocking a decision or active PR
- Can be recovered later if needed

---

## Next Steps

1. ✓ Triaged 182 issues → 39 survivors + 6 closures + 137 archived
2. (Manual) Close #546, #547, #548, #549, #550, #554 with evidence comment
3. (Manual) Label archived issues with `triage-candidate-archive-2026-08-05` for tracking
4. Future: Revisit archived backlog during sprint planning Q3 2026

