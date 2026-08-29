# Fix-Forward Integration Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the landed replacement chain satisfies the bounded security objective on clean main without inheriting PR #1236's unrelated scope.

**Architecture:** Materialize a fresh detached worktree at the final `origin/main`, verify ancestry and immutable gate receipts for every slice, run the whole repository evidence set, then execute cross-slice adversarial scenarios that exercise composed authorization and state transitions.

**Tech Stack:** Git, GitHub CLI/API, TypeScript/Vitest, Wrangler local D1, SHA-256 artifacts, Mupot receipts.

**Spec:** `docs/superpowers/specs/2026-08-29-pr1236-fix-forward-design.md`

## Global Constraints

- Start only after the required preceding slice merges are explicitly authorized by Hadi and present on `origin/main`.
- Audit from a new clean detached worktree; a developer checkout or prior green focused run is not evidence.
- `PASS-CODE`, merged, and deployed are distinct states; this goal prepares and verifies code but does not deploy.
- A failed required check, nonzero full suite, missing Athena Artifact+SHA256, or non-ancestor merge SHA blocks the final verdict.
- Confirm PR #1236 remains unmerged and was not extended by this program.

---

### Task 1: Build the Immutable Slice Ledger

**Files:**
- Create: `docs/receipts/pr1236-fix-forward/integration-slice-ledger.json`
- Read: all slice receipts under `docs/receipts/pr1236-fix-forward/`

**Interfaces:**
- Consumes: each slice PR number, base/head/merge SHA, required-check results, Lumen artifact, Athena Artifact+SHA256, and Loom request ID.
- Produces: machine-readable ledger with seven slice entries and no secret values.

- [ ] **Step 1: Verify every SHA relationship**

```bash
git fetch origin main
node -e 'const {execFileSync}=require("node:child_process"); const l=require("./docs/receipts/pr1236-fix-forward/integration-slice-ledger.json"); for (const s of l.slices) execFileSync("git",["merge-base","--is-ancestor",s.merge_sha,"origin/main"],{stdio:"inherit"}); for (let i=1;i<l.slices.length;i++) execFileSync("git",["merge-base","--is-ancestor",l.slices[i-1].merge_sha,l.slices[i].base_sha],{stdio:"inherit"})'
```

Expected: all exits `0`; record actual SHAs rather than branch labels.

- [ ] **Step 2: Verify every Athena artifact**

Compute SHA256 locally and compare with the received value. Confirm the artifact names the same immutable PR head recorded in the ledger.

- [ ] **Step 3: Verify GitHub required checks at each exact head**

Run the required-check query for every ledger PR and record each conclusion:

```bash
node -e 'const {execFileSync}=require("node:child_process"); const l=require("./docs/receipts/pr1236-fix-forward/integration-slice-ledger.json"); for (const s of l.slices) execFileSync("gh",["pr","checks",String(s.pr_number),"--required"],{stdio:"inherit"})'
```

Any missing, pending, or failed check blocks.

- [ ] **Step 4: Commit the ledger**

```bash
git add docs/receipts/pr1236-fix-forward/integration-slice-ledger.json
git commit -m "docs(audit): record fix-forward lineage"
```

### Task 2: Run the Final Clean-Main Repository Gate

**Files:**
- Create: `docs/receipts/pr1236-fix-forward/final-main-gate.md`

**Interfaces:**
- Consumes: detached final-main SHA.
- Produces: exact command exits and artifact paths for every required local gate.

- [ ] **Step 1: Create the detached audit worktree**

```bash
git worktree add --detach ../mupot-fix-forward-final-audit origin/main
git -C ../mupot-fix-forward-final-audit status --short
git -C ../mupot-fix-forward-final-audit rev-parse HEAD
```

Expected: empty status and the ledger's final main SHA.

- [ ] **Step 2: Run every repository gate**

```bash
npm run typecheck
npm test
node scripts/no-secrets.mjs
node scripts/check-test-schema-source.mjs
node scripts/check-migration-numbering.mjs origin/main
bash scripts/ci-local-evidence.sh
git diff --check
```

Record full-suite pass/fail counts and every exit. Do not summarize a nonzero exit as green.

- [ ] **Step 3: Verify migration materialization**

Create a fresh SQLite database, run `applyAllMigrationsUncached`, and query that the final token, approval/governance, delivery/presence, and message-integrity columns/tables exist exactly once.

- [ ] **Step 4: Commit the gate receipt**

```bash
git add docs/receipts/pr1236-fix-forward/final-main-gate.md
git commit -m "test(audit): verify final clean main"
```

### Task 3: Add Cross-Slice Adversarial Composition Tests

**Files:**
- Create: `tests/fix-forward-integration.test.ts`

**Interfaces:**
- Consumes: merged service interfaces from credential, governance/2FA, router/loop/meter, delivery/presence, and MSG-01 slices.
- Produces: one real-SQLite suite proving composed predicates cannot be bypassed between subsystems.

- [ ] **Step 1: Add credential plus 2FA scenario**

Prove an org admin with a valid approval can rotate once; another member, wrong action hash, wrong target, replayed approval, and squad-admin-only caller cannot rotate or consume the receipt.

- [ ] **Step 2: Add governance plus canonical identity scenario**

Prove two channels bound to one principal produce one vote, forged founder/seat inputs have no effect, and only explicit server-side founder authority can ratify the founder-dependent path.

- [ ] **Step 3: Add router plus meter scenario**

Prove an authorized same-squad route reserves the selected agent's durable budget; cross-squad route cannot assign or consume budget; caller cap/agent overrides do not change the reservation.

- [ ] **Step 4: Add producer plus delivery plus message-integrity scenario**

Prove send atomically registers the fence and integrity baseline; wrong seat cannot lease; valid seat consumes once and sees `is_intact: true`; same-length stored-body corruption returns false; replay stays blocked.

- [ ] **Step 5: Confirm mutation sensitivity**

For each scenario, temporarily remove its load-bearing predicate—approval principal match, canonical principal uniqueness, router squad match, and receiver seat match. The corresponding test must fail. Restore before commit.

- [ ] **Step 6: Verify and commit**

```bash
npx vitest run tests/fix-forward-integration.test.ts
npm run typecheck
npm test
git add tests/fix-forward-integration.test.ts
git commit -m "test(security): prove fix-forward composition"
```

### Task 4: Prove #1236 Exclusion and Final Governance State

**Files:**
- Create: `docs/receipts/pr1236-fix-forward/final-artifact.md`

**Interfaces:**
- Consumes: GitHub PR #1236 state/head/history and the slice ledger.
- Produces: final Artifact+SHA256 for Lumen, Athena, and Loom.

- [ ] **Step 1: Verify omnibus exclusion**

Confirm #1236 is not merged, none of the replacement branches use #1236 as base, and no program-authored commit was pushed to its head branch. Audit final-main diff for excluded device fleet, unified access, onboarding, journey, and migrations `0140`–`0142` unless independently merged outside this program and explicitly recorded.

- [ ] **Step 2: Separate result states**

The artifact must state separately: code gate, PR state, merge ancestry, deployment evidence, and production mutation evidence. Deployment and production mutation remain `NOT PERFORMED` unless separately authorized and evidenced.

- [ ] **Step 3: Hash and gate the final artifact**

```bash
sha256sum docs/receipts/pr1236-fix-forward/final-artifact.md
git diff --check origin/main...HEAD
```

Request Lumen review, resolve Critical/Important findings, rerun the complete final-main gate, then request Athena exact-head review naming the Artifact+SHA256.

- [ ] **Step 4: Ask Loom for final composition and stop**

Send the exact head, final artifact path/hash, slice ledger, Lumen result, and Athena verdict to Loom. Do not merge, deploy, rotate credentials, apply remote migrations, or mutate production.
