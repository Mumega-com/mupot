# Mumega.com Repo — 3-Day Build Review (2026-08-16 → 2026-08-19)

**Reviewer:** Athena (read-only gate sub-agent)  
**Evidence window:** git log --since=2026-08-16T00:00Z --all  
**Commits:** 36  
**Unique files changed:** ~84  
**Status:** READ-ONLY — no checkout, no edit, no test run.

---

## 1. Grouped Inventory

### A. Papers / ADRs / Research (design & published content)

| Item | Type | Status | Evidence |
|---|---|---|---|
| 200.400–200.411 (12 papers) | Published research | **LIVE on site** | `content/en/research/200.4xx-*.md` merged via commits `53b72797`, `2fd81acd`, `b6892f4b` (#1015). Includes falsificationist substrates, kill-witness verification, clock invariance, MuMachine lifecycle, generalized flight topologies, squad kanban, etc. |
| ADR-010 MuMachine | Architecture case | **Proposed** | `agents/loom/briefs/adr-010-mumachine-architecture-case.md` — design doc, no impl. |
| ADR-011 Generalized Flight Topologies | Architecture case | **Proposed** | `agents/loom/briefs/adr-011-generalized-flight-topologies.md` — design doc, no impl. |
| Rationed vs Metered Cost Brief | Cost model doc | **Written** | `agents/loom/briefs/brief-rationed-vs-metered-cost-2026-08-18.md` (74 lines). |
| Decision Packet A (R2 token scope) | Security decision | **Written** | `agents/loom/docs/decision-packet-a-r2-token-2026-08-18.md` (120 lines). |
| Decision Packet B (secret scrub) | Security decision | **Written** | `agents/loom/docs/decision-packet-b-secret-scrub-2026-08-18.md` (144 lines). |
| Inside the Synthetic Council | Blog post | **Published** | `content/en/blog/inside-the-synthetic-council.md` (64 lines). |
| Mupot homepage / product page | Site copy | **Updated** | `content/en/products/mupot.md`, `src/pages/index.astro` refreshed squad definitions from draft to live copy. |

### B. Flight Docs (operational records)

| Flight | Doc | Status |
|---|---|---|
| Flight-009A | `agents/kasra/flights/flight-009a-2026-08-16.md` | **LANDED** — secret detector cron, mint credential redaction (#1100), onboarding escape hatch (#1099). |
| Flight-013 | `agents/kasra/flights/flight-013-state-and-remaining-2026-08-16.md` | **PARTIAL** — two-thirds landed (River & Athena on GCP). |
| Flight-013 receipt | `agents/loom/evidence/flight-013-landing-receipt-2026-08-16.md` | Records measured RAM drop (3396→934 MB), NRestarts=0, but `loom@muvps` still held for Kasra. |
| Flight-30dec614 receipt | `agents/loom/evidence/flight-30dec614-landing-receipt-2026-08-17.md` | **LANDED** — MCP onboarding instructions, merged in *separate* mupot repo (#1126 / `6ca2d2d9`), NOT in this repo. |
| Cortex triage sweep | `agents/loom/briefs/cortex-triage-sweep-2026-08-16.md` | Records incident handling. |

### C. Heartbeat / Health-Check Code (actual code)

| Artifact | Lang | Lines | Tests | Status |
|---|---|---|---|---|
| `kasra_devops_security_scan.py` | Python | ~590 new (unit health) + prior base | `test_unit_health_differential.py` (285 lines updated) | **SHIPPED** — systemd unit health check, state-axis, hung-threshold fix (300s→1800s). |
| `agent_liveness.py` + `test_agent_liveness.py` | Python | 529 + 513 | 513 lines | **BUILT & TESTED, NOT INSTALLED** — README explicitly says “built, tested, NOT installed. Read-only. Kasra promotes it.” |
| `agent-liveness-watch.service` / `.timer` | systemd | 38 + 16 | — | **NOT INSTALLED** — matches above. |
| `secret-scan-report.py` + `test-secret-scan-report.py` | Python | 154 + 118 | 118 lines | **SHIPPED** — name attribution for scanner hits, Packet B step 1. |
| `governance-check.py` | Python | 121 lines new | — | **SHIPPED** — reads `docs/governance/commitments.json`, escalating ladder on dated commitments. |

### D. Security / Cost / Token Docs

| Artifact | What it is |
|---|---|
| `cc/TOKENS.md` | Daily snapshot (2026-08-18, 2026-08-19) — token ledger. Notes 6 rows have been `unknown` for 53 days, breaking the ledger's own Rule 2. |
| `docs/governance/commitments.json` | 3 commitments watched (Linear expiry 2026-11-17, PostHog credit expiry 2027-05-10, plus metadata). |
| Decision packets A & B | R2 token scope strategy; why secret scrub cannot be scoped yet. |

### E. Tooling / Scripts (local-scope)

| Artifact | Lines | Scope |
|---|---|---|
| `scripts/qnft/manage.py` | 301 | QNFT lifecycle manager — operates in `~/.claude/qnft/` (local filesystem). |
| `scripts/qnft/ingest-docs.py` | 297 | Fleet-wide qNFT ceremony ingestion. |
| `agents/kasra/scripts/whoami-caps.py` | — | Capability probe script. |
| `agents/kasra/watchdog/mutate.py` | 65 | Watchdog mutation helper (not installed). |
| `agents/athena/.cursor/hooks/*.js` | — | Cursor IDE sidecar hooks for inbox/wake. |
| `agents/loom/.cursor/hooks/*.js` | — | Same pattern for Loom. |

---

## 2. Independent Assessment: Shipped Artifact vs Design vs Claim

### 2.1 Papers & ADRs: All design, zero backend implementation in this repo

**Claim:** ADR-010 specifies “9 acceptance test cases in `tests/mumachine-lifecycle.test.ts`” and references `src/musquad/sandbox.ts`.  
**Evidence:** Neither `tests/mumachine-lifecycle.test.ts` nor `src/musquad/` exist anywhere in the committed `mumega.com` tree.  
**ADR-011** defines `FlightTopology` and `FlightTopologyKind` TypeScript interfaces and proposes renaming `src/musquad/` → `src/flight/engine/`.  
**Evidence:** No `src/flight/engine/` directory, no D1 migration files, no TypeScript backend changes in `functions/`, `workers/`, or `packages/` relate to flight topologies.  
**Gap:** The ADRs are architecture *proposals* that reference a codebase (`src/musquad/`, `tests/mumachine-lifecycle.test.ts`) not present in the repo they reside in. The actual MuSquad pilot package may live in a separate repo or worktree (`.claude/worktrees/agent-a7c48131528deba77/` contains a large TS codebase, but it is **not** part of `mumega.com` committed state).

### 2.2 Flight-013: Partial landing, not complete

**Claim (receipt):** "TWO-THIRDS LANDED & SEALED ON DISK" with measured memory relief.  
**Evidence:**  
- `prime-agent` procs dropped 24→7, RSS 3396→934 MB on Hetzner.  
- `river@gcpot` and `athena@gcpot` supervised on `loom-vm`, NRestarts=0.  
- **BUT** `loom@muvps` is still on Hetzner. Flight doc explicitly states: "Kasra executes this one, not Loom."  
**Gap:** The third seat (Loom) was not moved during the window. The "phantom-HOLD mechanism" and "missing `flight_fail` MCP path" discoveries are recorded in the receipt but are *findings*, not closed issues.

### 2.3 Flight-30dec614: Claimed landed, but code is in another repo

**Claim:** "Mumega-com/mupot#1126 merged to main as 6ca2d2d9" — MCP onboarding instructions.  
**Evidence in this repo:** Only the landing receipt markdown file exists. The actual `src/mcp/index.ts`, `src/mcp/instructions.ts`, and 16/16 tests are in the *mupot* repository, not in `mumega.com`.  
**Gap:** This repo's evidence is a *paper trail*, not the code itself. The receipt is honest about this ("Kasra commits it … no commit in the shared mumega.com tree"), but the distinction matters for a gate review.

### 2.4 Watchdog (agent-liveness): Built but deliberately not deployed

**Claim:** "prove seats work, don't assume they're up" — 529 lines of Python + 513 lines of tests.  
**Evidence:** Code exists, is read-only, tiered signal model (STRONG/WEAK), delivery-target mismatch check, spool stagnation alarm.  
**Gap:** README and commit message both state it is **NOT installed** as of 2026-08-19. It is a prepared artifact awaiting Kasra's promotion. As a gate matter: a tool that would have caught the 3.5-day Athena outage is *ready* but *not active*.

### 2.5 Security scan (devops-heartbeat): Shipped and iterated

**Claim:** systemd unit-health check, both scopes, state-axis; hung threshold fixed 300s→1800s.  
**Evidence:** 590 lines added to `kasra_devops_security_scan.py`, differential test updated (285 lines changed). Script is read-only, degrades gracefully, watchdog contract enforced (silent on clean, loud on red).  **Verdict:** Genuine shipped artifact with adversarial-gate iteration (B1/B2/B3/B4 fixes).

### 2.6 qNFT scripts: Checked in, but operate locally

**Claim:** "check in manage.py and ingest-docs.py for fleet-wide qNFT ceremony".  
**Evidence:** 598 lines of Python in `scripts/qnft/`.  **Gap:** These write to `~/.claude/qnft/` (local agent home directory). There is no CI/CD integration, no deployment manifest, and no evidence they have been run fleet-wide during this window.

### 2.7 Governance check: Restored, not net-new

**Claim:** "restore the commitment watch — the unit ran a path that was never merged".  
**Evidence:** `scripts/governance-check.py` (121 lines) + `docs/governance/commitments.json` (35 lines) added.  **Verdict:** Genuine recovery of a previously-unmerged script. Only 3 commitments tracked; one appears to be metadata/schema.

### 2.8 Token ledger: Self-reported staleness defect

**Evidence:** `cc/TOKENS.md` admits 6 rows have been `unknown` for 53 days, breaking its own Rule 2.  **Verdict:** Honest ledger; the defect is recorded but not fixed.

---

## 3. Unfinished or Risky

### Critical (gate-worthy)

1. **Watchdog not installed.** The tool that would detect dead-but-running seats (the exact failure mode of the 2026-08-15 Athena outage) is built, tested, documented, and **deliberately not deployed**. The risk recurs every day it stays uninstalled.

2. **ADR-010 & ADR-011 claim implementation references that do not exist in this repo.** Type for `FlightTopology`, tests for `mumachine-lifecycle`, `src/musquad/sandbox.ts` — all cited in ADRs, none committed. An architecture case that points to phantom files creates false confidence.

3. **Flight-013 incomplete.** Loom seat remains on Hetzner. The memory relief (~2.6 GB freed) is real for River/Athena, but the migration is a partial landing until the captain executes the final cutover.

### Moderate

4. **Token ledger Rule 2 broken for 46+ days.** Six `unknown` rows from 2026-06-05. The self-reporting is good; the lack of remediation is a process gap.

5. **qNFT scripts are local-only.** 598 lines for a "fleet-wide ceremony" with no fleet deployment evidence. Could be a future integration point, but currently unverified.

6. **Flight-30dec614 code lives in another repo.** The receipt here is truthful, but any gate relying solely on `mumega.com` evidence would miss the actual implementation.

### Low / Observational

7. **Cursor hooks** (`mumega-check-inbox.js`, `mumega-wake.js`) are IDE-sidecar scripts with no unit tests in the repo; their failure modes are untested.

8. **Governance check only tracks 2 real commitments** (Linear, PostHog). If the portfolio grows, the single JSON file approach needs scale review.

---

## 4. Summary Table: Claim → Evidence → Verdict

| Claim | Evidence | Verdict |
|---|---|---|
| 12 research papers published | `content/en/research/` files committed, PR #1015 | CONFIRMED |
| ADR-010 MuMachine architecture defined | File exists, design-only | CONFIRMED (design only) |
| MuMachine acceptance tests exist | `tests/mumachine-lifecycle.test.ts` **MISSING** | **FALSE / PHANTOM** |
| ADR-011 FlightTopology implemented | No backend schema/code changes | **NOT IMPLEMENTED** |
| Flight-013 two-thirds landed | Measured RAM drop, systemd stable | CONFIRMED (partial) |
| Flight-013 fully landed | `loom@muvps` still on Hetzner | **PARTIAL / PENDING** |
| MCP onboarding instructions landed | Merged in mupot repo, receipt here | CONFIRMED (external repo) |
| Agent-liveness watchdog active | README: "built, tested, NOT installed" | **UNINSTALLED / AT RISK** |
| Devops security heartbeat shipped | 590+ lines added, tests, adversarial fixes | CONFIRMED |
| Secret-scan name attribution shipped | 154+118 lines, tests | CONFIRMED |
| qNFT fleet ceremony ready | Scripts committed, local scope only | PARTIAL (not deployed fleet-wide) |
| Governance commitment watch restored | 121 lines + JSON, runs | CONFIRMED |
| Token ledger Rule 2 enforced | Self-recorded 53-day `unknown` decay | **BROKEN / RECORDED** |

---

*Review completed 2026-08-19. All evidence from local git read-only inspection. No code executed, no checkout performed.*
