# Mupot v0.30.0 Stabilization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Produce one immutable, independently gated Mupot v0.30.0 main SHA with complete truthful pre-RC evidence and a hashed RC1 approval packet, without creating a tag or deployment.

**Architecture:** Work proceeds through sequential, bounded PRs. #1252 is restacked and gated first but not merged automatically; authorization, local-evidence, release-checker, freeze-binding, and final metadata changes each receive their own TDD and review cycle. The merge commit of the final metadata PR becomes the release SHA, and every pre-RC receipt is collected afterward against a shared release-evidence context.

**Tech Stack:** TypeScript, Node.js ESM, Vitest, Node test runner, Hono, Cloudflare Workers/D1/Queues/KV/R2/Vectorize, Wrangler, Playwright, GitHub CLI/API, code-review-graph.

**Spec:** `docs/superpowers/specs/2026-08-31-mupot-v030-stabilization-design.md`

## Global Constraints

- Initial `main` is `c6ef9876db7575d86de85df378049663d627033b`; always refresh it before creating a task worktree.
- Use one isolated worktree and one write-owning worker per branch. Read-only reviewers may run in parallel.
- Use code-review-graph before broad file reads; rebuild it at every exact gate head.
- TDD is mandatory: record the expected RED, implement the smallest change, then record GREEN.
- Preserve `mupot-sos-cutover-gate/v1` and all v0.23 historical paths exactly.
- Never print or copy bearer values, private keys, OAuth secrets, Cloudflare tokens, or GitHub App keys into logs, files, receipts, PR bodies, or messages.
- Do not merge any PR without a direct Hadi instruction naming that PR.
- Do not create/move a tag, create a GitHub Release, deploy, apply production migrations, change credentials/ACLs/branch protection, or perform live Host-Go control without separate direct approval.
- Any merge after the frozen SHA invalidates all candidate and RC evidence.
- Required remote evidence means every current CI job plus CodeQL is terminal-successful on the exact SHA; pending or neutral is not GREEN.
- Keep release-excluded #1246, #1247, and #1248 unmerged with branches preserved.
- Final objective stops with RC1 approvals pending; phase-bound RC/stable/publication receipts remain explicitly pending.

---

### Task 1: Restack and complete PR #1252

**Files:**
- Modify: `src/fleet/presence.ts`
- Modify: `src/presence/seven-axis.ts`
- Modify: `src/mcp/index.ts`
- Modify: `src/mcp/instructions.ts`
- Modify: `tests/seven-axis-presence.test.ts`
- Modify: `tests/mcp-instructions.test.ts`

**Interfaces:**
- Consumes: `SEVEN_AXIS_HARNESSES`, `normalizeHarness()`, `parseSevenAxisCheckin()`, MCP `check_in` schema, `MUPOT_MCP_INITIALIZE_INSTRUCTIONS`.
- Produces: exact accepted harness value `codex-cli` across persistence, parsing, schema, and static instructions. It does not alter bearer-derived identity or existing rows.

- [ ] **Step 1: Create the isolated restack worktree**

```bash
git fetch origin main codex/host-bootstrap
test "$(git rev-parse refs/remotes/origin/codex/host-bootstrap)" = "1513f3a5e7bdd74e29894f909421eb2d5ff989fd"
git worktree add -b restack/pr1252 \
  /mnt/HC_Volume_104325311/mupot-worktrees/v030-pr1252 \
  refs/remotes/origin/codex/host-bootstrap
cd /mnt/HC_Volume_104325311/mupot-worktrees/v030-pr1252
git rebase --onto origin/main ccfdb4b3247b46108618d5b1c58a5d0f63ed8147
```

Expected: one rebased commit, clean tree, `git merge-base HEAD origin/main` equals `origin/main`.

- [ ] **Step 2: Write missing contract tests before production changes**

Add assertions that:

```ts
expect(parseSevenAxisCheckin({ harness: 'codex-cli' }).harness).toBe('codex-cli')
expect(parseSevenAxisCheckin({ harness: 'codex' }).harness).toBeNull()
expect(normalizeHarness('codex-cli')).toBe('codex-cli')
expect(normalizeHarness('codex')).toBe('unknown')
expect(toolCheckIn.inputSchema.properties.harness.enum).toContain('codex-cli')
expect(MUPOT_MCP_INITIALIZE_INSTRUCTIONS).toContain('"codex-cli"')
```

Use the existing public tool-catalog/test helper rather than exporting a private `toolCheckIn` solely for tests.

- [ ] **Step 3: Run the new focused tests and record RED**

```bash
npx vitest run tests/seven-axis-presence.test.ts tests/mcp-instructions.test.ts
```

Expected RED: MCP static instructions omit `codex-cli`; any parser assertion not already covered also fails.

- [ ] **Step 4: Complete the vocabulary contract**

Add `codex-cli` once to both canonical arrays and both accepted-harness instruction surfaces. Do not accept bare `codex`, case-folded variants, or trimmed variants.

- [ ] **Step 5: Run focused GREEN and adjacent coverage**

```bash
npx vitest run \
  tests/seven-axis-presence.test.ts \
  tests/fleet-presence.test.ts \
  tests/river-copilot-caching.test.ts \
  tests/mcp-instructions.test.ts
npm run typecheck
```

- [ ] **Step 6: Run the exact-head local gate**

```bash
npm test
npx vitest run --config vitest.composition.config.ts
node --test 'fleet-runtime/**/*.test.mjs'
node --test tests/router.test.mjs
npm audit --omit=dev --audit-level=moderate
node --test tests/audit-gate.test.mjs
npx wrangler deploy --dry-run --config wrangler.example.toml
git diff --check origin/main...HEAD
```

- [ ] **Step 7: Commit and update the existing PR branch safely**

```bash
git add src/fleet/presence.ts src/presence/seven-axis.ts src/mcp/index.ts src/mcp/instructions.ts tests/seven-axis-presence.test.ts tests/mcp-instructions.test.ts
git commit -m "fix(presence): align Codex CLI harness"
git push --force-with-lease=refs/heads/codex/host-bootstrap:1513f3a5e7bdd74e29894f909421eb2d5ff989fd origin HEAD:codex/host-bootstrap
```

Update PR #1252 body with old/new base/head, RED/GREEN evidence, full gates, and the explicit descriptive-not-authoritative harness boundary.

- [ ] **Step 8: Gate #1252 and stop before merge**

Require exact-head graph, whole-diff review, CI/CodeQL, and Athena GREEN. Record whether the release train includes or defers #1252. Do not merge.

### Task 2: Fix active-principal gate authorization (#1080)

**Files:**
- Modify: `src/gates/grants.ts`
- Modify: `src/tasks/index.ts`
- Modify: `src/mcp/index.ts`
- Create: `tests/task-verdict-principal-liveness.test.ts`
- Modify: `tests/mcp-task-tools.test.ts`
- Modify: `tests/tasks-gate.test.ts`

**Interfaces:**
- Produces: `principalHoldsActiveGateCapability(env, capability, principalType, principalId): Promise<boolean>` and `verdictPrincipalIsActive(env, auth): Promise<boolean>`.
- Preserves: owner/admin bypass for unbound web sessions, bound-agent precedence, existing verdict receipt shape.

- [ ] **Step 1: Start from the post-#1252-disposition main**

```bash
git fetch origin main
BASE_SHA=$(git rev-parse origin/main)
git worktree add -b fix/v030-active-gate-principal /mnt/HC_Volume_104325311/mupot-worktrees/v030-gate-liveness "$BASE_SHA"
cd /mnt/HC_Volume_104325311/mupot-worktrees/v030-gate-liveness
```

- [ ] **Step 2: Write real-schema RED tests**

Use `createSqliteD1()` and `applyAllMigrations()` to construct:

```ts
it('denies a paused bound agent with a surviving gate grant')
it('denies a paused assignee on gate:agent-self-completion')
it('allows an active bound agent with the exact grant')
it('allows an active unbound member with the exact grant')
it('denies a suspended member in the active-grant primitive')
it('denies a deleted principal row')
```

For denials, assert HTTP/MCP 403, task stays `review`, and `task_verdicts` count remains zero.

- [ ] **Step 3: Run RED**

```bash
npx vitest run tests/task-verdict-principal-liveness.test.ts tests/mcp-task-tools.test.ts
```

Expected RED: paused-agent ordinary and self-completion verdicts succeed on current code.

- [ ] **Step 4: Implement the active-principal primitive**

In `src/gates/grants.ts`, add a single query with principal-specific existence checks:

```ts
export async function principalHoldsActiveGateCapability(
  env: Env,
  capability: string,
  principalType: GatePrincipalType,
  principalId: string,
): Promise<boolean>
```

Member liveness requires `members.id`, `tenant = env.TENANT_SLUG`, and `status='active'`. Agent liveness requires `agents.id` and `status='active'`. Missing rows deny.

- [ ] **Step 5: Enforce liveness in both verdict paths**

Update `callerHoldsGateCapability()` to call the primitive. Add `verdictPrincipalIsActive()` before the self-completion branch in REST and MCP. Preserve owner/admin bypass only for unbound human sessions; a bound paused agent cannot inherit the member envelope's activity.

- [ ] **Step 6: Run GREEN and mutation checks**

```bash
npx vitest run tests/task-verdict-principal-liveness.test.ts tests/mcp-task-tools.test.ts tests/tasks-gate.test.ts
```

Mutation proof must show each of these turns RED: removing agent status, removing member status, skipping self-completion precheck, resolving a bound token as member, or allowing a missing principal row.

- [ ] **Step 7: Full verification, review, PR, Athena, merge stop**

Run the Task 1 full gate, create the PR, obtain independent exact-head review and Athena GREEN, then stop for direct merge approval.

### Task 3: Unify action-specific verdict authority (#1081)

**Files:**
- Create: `src/tasks/verdict-authority.ts`
- Modify: `src/tasks/index.ts`
- Modify: `src/mcp/index.ts`
- Modify: `src/dashboard/approvals.ts`
- Modify: `src/dashboard/index.ts`
- Create: `tests/task-verdict-authority-real-schema.test.ts`
- Modify: `tests/dashboard-approvals.test.ts`
- Modify: `tests/mcp-task-tools.test.ts`
- Modify: `tests/tasks-gate.test.ts`
- Modify: `tests/surface-caps.test.ts`

**Interfaces:**
- Produces:

```ts
export type VerdictAction = 'approved' | 'rejected'
export type VerdictAuthorityDecision =
  | { allowed: true; principalId: string; actor: 'member' | 'agent' }
  | { allowed: false; code: string; need?: string }

export async function authorizeTaskVerdict(
  env: Env,
  auth: AuthContext,
  task: Task,
  input: { verdict: VerdictAction; overrideSelfVerdict: boolean },
): Promise<VerdictAuthorityDecision>
```

- Consumers: REST verdict route, MCP `task_verdict`, dashboard projection/batch controls.

- [ ] **Step 1: Write the authority matrix as RED tests**

Cover:

```text
bound agent grant, envelope member no grant        -> allow
envelope member grant, bound agent no grant        -> deny
gate grant, no squad capability                    -> deny
gate:loops reject without outreach cap             -> allow
gate:loops approve without outreach cap            -> deny
self-assignee ordinary gate                         -> deny
active assignee self-completion gate                -> allow
project evidence write revoked                      -> deny
owner explicit self-verdict override                -> allow
```

- [ ] **Step 2: Run RED against existing forked predicates**

```bash
npx vitest run tests/task-verdict-authority-real-schema.test.ts tests/dashboard-approvals.test.ts tests/mcp-task-tools.test.ts tests/tasks-gate.test.ts tests/surface-caps.test.ts
```

- [ ] **Step 3: Implement the shared authorizer**

Move decision order and refusal codes into `verdict-authority.ts`. Keep persistence in `writeVerdict`; the authorizer performs no mutation.

- [ ] **Step 4: Adopt in REST, MCP, and dashboard**

REST and MCP translate the same typed refusal into their existing status/error shapes. Dashboard items expose `can_approve`, `can_reject`, `approve_refusal`, and `reject_refusal`. Batch controls enable only actions allowed for every selected item.

- [ ] **Step 5: Replace brittle source-order tests**

Delete copied-SQL and source-index assertions that do not call production authority. Preserve behavior through the real authorizer and real-schema matrices.

- [ ] **Step 6: Verify queue performance**

Graph/trace the approval render path. Batch-load authority facts or enforce the existing bounded queue size; do not issue an unbounded per-item query cascade.

- [ ] **Step 7: Full verification, review, PR, Athena, merge stop**

Run full gates, then exact-head review and Athena. Stop for merge approval.

### Task 4: Make local evidence deterministic (#1097)

**Files:**
- Modify: `scripts/ci-local-evidence.sh`
- Modify: `scripts/local-browser-smoke.mjs`
- Modify: `tests/local-browser-smoke.test.ts`
- Modify: `.github/workflows/ci.yml` only if a bounded manual rerun trigger is explicitly approved

**Interfaces:**
- Produces structured browser resource failures `{ url, status, origin, resourceType, route, navigationId }` and condition-based authenticated-root readiness.

- [ ] **Step 1: Write RED tests for structured failures and attribution**

Add cases proving same-origin 404 fatality, exact Google Font cosmetic handling, `pageerror` fatality, delayed previous-navigation isolation, and authenticated-root readiness timeout.

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/local-browser-smoke.test.ts
```

- [ ] **Step 3: Capture response/request metadata**

Replace global console-string attribution with response/request-failed records keyed by navigation ID. Never allowlist a generic console phrase or all third-party errors.

- [ ] **Step 4: Make local font loading hermetic**

For local evidence, block exact `fonts.googleapis.com` and `fonts.gstatic.com` requests before navigation and record them as expected cosmetic blocks. All other failed resources remain evidence.

- [ ] **Step 5: Replace fixed readiness sleep**

After `/health`, poll authenticated `/` until status 200, meaningful body, and no same-origin resource failures, with the existing 90-second ceiling.

- [ ] **Step 6: Run focused and repeated GREEN**

```bash
npx vitest run tests/local-browser-smoke.test.ts
for run in 1 2 3; do bash scripts/ci-local-evidence.sh; done
```

Each run must produce a complete report and no unexplained allowlisted failure.

- [ ] **Step 7: Full verification, review, PR, Athena, merge stop**

Run full gates and stop after gate for merge approval.

### Task 5: Enforce release readiness gate parity and issue scope

**Files:**
- Modify: `scripts/release-readiness-receipt.mjs`
- Modify: `tests/release-readiness-receipt.test.ts`

**Interfaces:**
- Produces complete `REQUIRED_PR_CHECKS`/`REQUIRED_COMMIT_CHECKS` and optional contract `issue_scope` enforcement.

- [ ] **Step 1: Add workflow-parity RED tests**

Parse `.github/workflows/ci.yml` and assert every job key exists in both appropriate required-check lists. Add missing/failing `reserved-bindings` and `migration-numbering` receipt cases.

- [ ] **Step 2: Add issue-scope RED tests**

Contracts with:

```json
{"issue_scope":{"milestone":"v0.30.0 - Stabilized Control Plane","require_zero_open":true}}
```

must require `github-release-scope-issues.json`, reject open/malformed entries, and accept an empty array. A contract without `issue_scope` preserves v0.23 behavior.

- [ ] **Step 3: Run RED**

```bash
npx vitest run tests/release-readiness-receipt.test.ts tests/design-status-contract-policy.test.ts
```

- [ ] **Step 4: Implement parity and fail-closed issue export checks**

Add all ten CI job names. Keep aggregate `CodeQL` PR-only and named analyses on PR/push. Generate a read-only GitHub issue export plan for the exact milestone.

- [ ] **Step 5: Focused/full gates, review, PR, Athena, merge stop**

Run release-focused tests, typecheck, full tests, and full remote gates. Stop for merge approval.

### Task 6: Enforce live evidence, milestone, and soak integrity

**Files:**
- Modify: `scripts/stable-deployment-receipt.mjs`
- Modify: `tests/stable-deployment-receipt.test.ts`
- Modify: `scripts/release-integrity-receipt.mjs`
- Modify: `tests/release-integrity-receipt.test.ts`
- Modify: `scripts/production-soak-receipt.mjs`
- Modify: `tests/production-soak-receipt.test.ts`

**Interfaces:**
- Stable aggregate binds raw health hash and embedded/raw equality.
- Integrity plan exports all milestone states and requires exactly one match.
- Soak receipts require explicit RC version and frozen SHA.

- [ ] **Step 1: Write stable-deployment RED matrix**

Reject missing/failing deployment status, missing/false `health.clean`, missing raw health, raw/embedded disagreement, and secret-bearing raw health without echoing secret values.

- [ ] **Step 2: Write milestone and soak RED matrix**

Require `state=all`, reject zero/multiple milestones, reject soak observations from another/mixed SHA, and reject v0.23-defaulted v0.30 plans.

- [ ] **Step 3: Run RED**

```bash
npx vitest run tests/stable-deployment-receipt.test.ts tests/release-integrity-receipt.test.ts tests/production-soak-receipt.test.ts
```

- [ ] **Step 4: Implement minimal integrity changes**

Hash raw `health.json`, compare exact fields, paginate milestone state-all export, require exactly one match, and make soak version/SHA explicit across start/day/cycle/end receipts.

- [ ] **Step 5: Focused/full gates, review, PR, Athena, merge stop**

Run full verification and stop for merge approval.

### Task 7: Bind every release receipt to the frozen context

**Files:**
- Create: `scripts/lib/release-evidence-context.mjs`
- Create: `tests/release-evidence-context.test.ts`
- Modify: `scripts/release-readiness-receipt.mjs`
- Modify: `tests/release-readiness-receipt.test.ts`
- Modify: `scripts/fresh-install-receipt.mjs`
- Modify: `tests/fresh-install-receipt.test.ts`
- Modify: `scripts/github-app-permissions-receipt.mjs`
- Modify: `tests/github-app-permissions-receipt.test.ts`
- Modify: `scripts/work-lifecycle-receipt.mjs`
- Modify: `tests/work-lifecycle-receipt.test.ts`
- Modify: `scripts/external-pr-cycle-receipt.mjs`
- Modify: `tests/external-pr-cycle-receipt.test.ts`
- Modify: `scripts/staging-recovery-rehearsal.mjs`
- Modify: `tests/staging-recovery-rehearsal.test.ts`
- Modify: `fleet-runtime/receipt-bundle.mjs`
- Modify: `fleet-runtime/receipt-bundle.test.mjs`

**Interfaces:**
- Produces `mupot-release-evidence-context/v1` and `context_sha256`.
- Every v0.30 aggregate records `release_sha`, `evidence_started_at`, `evidence_completed_at` or `exported_at`, and `context_sha256`.

- [ ] **Step 1: Write the context schema and RED tests**

Use this exact envelope:

```json
{
  "receipt_type": "mupot-release-evidence-context/v1",
  "version": "0.30.0",
  "release_sha": "40 lowercase hex",
  "frozen_at": "ISO timestamp",
  "release_pr": 0,
  "release_merge_sha": "same 40 lowercase hex",
  "contract_sha256": "64 lowercase hex"
}
```

Reject dirty checkout, off-`origin/main`, caller mismatch, malformed SHA/hash/time, and release-merge mismatch.

- [ ] **Step 2: Run context RED**

```bash
npx vitest run tests/release-evidence-context.test.ts
```

- [ ] **Step 3: Implement context creation and canonical hashing**

Resolve Git facts from commands whose exit status is checked. Canonicalize JSON before hashing. Never accept an environment SHA without matching Git.

- [ ] **Step 4: Add receipt-specific RED tests**

Reject another SHA, pre-freeze native evidence, altered context hash, internally consistent recovery for SHA B when freeze is A, stale Host-Go source receipt, stale App export, and future timestamps.

- [ ] **Step 5: Thread context through producers/checkers**

Keep common validation in `release-evidence-context.mjs`. Each producer owns its native time field; readiness validates all aggregates against one root context.

- [ ] **Step 6: Preserve legacy isolation**

Run v0.23 readiness and legacy Host-Go tests. Legacy paths do not synthesize v0.30 context.

- [ ] **Step 7: Full gates, whole-branch review, PR, Athena, merge stop**

This is the highest-risk tooling PR. Require a full graph rebuild, affected-flow audit, independent whole-branch review, CI/CodeQL, and Athena before merge approval.

### Task 8: Reconcile and activate final v0.30 metadata

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `ROADMAP.md`
- Modify: `docs/releases/v0.30.0.md`
- Modify: `docs/releases/v0.30.0-contract.json`
- Modify: `docs/production-runbook.md`
- Modify: `tests/release-v030-contract.test.ts`

**External metadata:**
- Create GitHub milestone `v0.30.0 - Stabilized Control Plane` only through an authenticated, separately receipted metadata action.

**Interfaces:**
- Activates the completed tooling contracts without implementing checker logic.
- Its merge commit becomes the frozen release SHA.

- [ ] **Step 1: Write cross-document RED tests**

Assert source version, README, CHANGELOG, ROADMAP, release document, contract, issue scope, soak, stable raw-health/clean requirements, corrected audit command, and recursive fleet command agree.

- [ ] **Step 2: Run RED**

```bash
npx vitest run tests/release-v030-contract.test.ts tests/release-readiness-receipt.test.ts tests/release-integrity-receipt.test.ts tests/stable-deployment-receipt.test.ts tests/release-candidate-receipt.test.ts
```

- [ ] **Step 3: Correct release truth**

Record #1250/#1251, the exact #1252 disposition, #1246/#1247/#1248 deferral, completed tooling PRs, current preview deployment, pending milestone/tag/release/deploy state, and final release order.

- [ ] **Step 4: Activate the final contract**

Add release evidence context, issue scope, soak, stable raw health/clean, and phase-correct receipt lists. Prepublication excludes postpublication integrity; final includes all receipts.

- [ ] **Step 5: Create and verify the milestone metadata**

Create the new milestone without renaming old milestone #9. Assign the closed release-blocker issues #1080, #1081, and #1097 to it, plus any closed tracker issues created for Tasks 5-7. Export it read-only and prove the milestone is non-empty, has the exact title/state, and has zero open issues. Keep it open until stable publication.

- [ ] **Step 6: Full verification, review, PR, Athena, merge stop**

Run all release-focused tests plus full gates. Obtain exact-head review/Athena, then stop for direct merge approval.

### Task 9: Freeze the final metadata merge commit

**Files:**
- Create outside source tree: `tmp/release-readiness/v0.30.0/release-evidence-context.json`
- Create: `tmp/release-readiness/v0.30.0/00-freeze/frozen-sha.json`
- Create: `tmp/release-readiness/v0.30.0/00-freeze/source-metadata-hashes.json`

**Interfaces:**
- Produces immutable `F`, tree, `frozen_at`, release PR/merge receipt, contract hash, and context hash.

- [ ] **Step 1: Verify the final merge**

```bash
git fetch origin main
RELEASE_SHA=$(git rev-parse origin/main)
test "$RELEASE_SHA" = "$(gh pr view "$V030_RELEASE_PR" --repo Mumega-com/mupot --json mergeCommit --jq '.mergeCommit.oid')"
```

`V030_RELEASE_PR` is set from the merged final metadata PR receipt, not typed from memory.

- [ ] **Step 2: Create a detached exact-SHA evidence worktree**

```bash
git worktree add --detach /mnt/HC_Volume_104325311/mupot-worktrees/v030-freeze "$RELEASE_SHA"
cd /mnt/HC_Volume_104325311/mupot-worktrees/v030-freeze
test -z "$(git status --porcelain -uall)"
```

- [ ] **Step 3: Generate and hash the release context**

Run the new context tool with the release PR, contract path, and an output path under `tmp/release-readiness/v0.30.0/`. Record tree and all source metadata blob hashes.

- [ ] **Step 4: Prove exact-head local and remote gates**

Run all Task 1 local gates, `bash scripts/ci-local-evidence.sh`, graph rebuild/review, PR check exports, push check exports, and CodeQL. Stop if any item is pending/failing or if `origin/main` changes.

### Task 10: Collect every truthful pre-RC objective receipt

**Files:**
- Populate: `tmp/release-readiness/v0.30.0/`
- Populate: `tmp/release-readiness/v0.30.0/host-go/`
- Populate receipt-specific subdirectories under `02-objectives/`

**Required environment names:**
- `V030_FRESH_POT_SLUG`
- `V030_FRESH_BASE_URL`
- `V030_FRESH_OPERATOR_ID`
- `V030_STAGING_POT_SLUG`
- `V030_STAGING_BASE_URL`
- `V030_AGENT_ID`
- `V030_LIFECYCLE_TASK_ID`
- `V030_EXTERNAL_REPO`
- `V030_EXTERNAL_TASK_ID`
- `V030_EXTERNAL_ISSUE_URL`
- `V030_EXTERNAL_PR_URL`
- `V030_GITHUB_APP_SLUG`
- `V030_GITHUB_ORG`
- `V030_GITHUB_INSTALLATION_ID`

Credential values remain in protected bindings and are never printed.

- [ ] **Step 1: Fail closed on missing non-secret inputs**

Run a shell preflight using `${NAME:?required}` for every name above. Verify protected credential files by existence/mode only.

- [ ] **Step 2: Collect fresh-install evidence**

Run the generated plan on the approved throwaway target. Require all six ordered step receipts and aggregate PASS. Manual D1 repair invalidates the receipt.

- [ ] **Step 3: Export/check GitHub App permissions**

Use authenticated read-only export. If permissions differ, stop; do not repair or reaccept silently.

- [ ] **Step 4: Collect Host-Go evidence**

Collect signed attach, inbox handoff, start/stop controls, neutral cutover gate, portable export, and copied-bundle check for exact `V030_AGENT_ID`. Verify source receipt times are after freeze and no values leak.

- [ ] **Step 5: Collect work lifecycle evidence**

Create/execute/review/approve/complete one real bounded task with distinct agent and human/gate attribution. Require audit visibility and frozen context binding.

- [ ] **Step 6: Collect external PR cycle evidence**

Use the exact task/issue/PR inputs and prove task-to-GitHub linkage, checks, review, merge/result visibility, and final verification. Do not invent a new PR solely to fill a receipt unless the approved evidence task requires it.

- [ ] **Step 7: Run staging recovery rehearsal**

Prove backup, upgrade to `F`, restore to new D1, rollback, re-deploy `F`, Queue/DLQ, failure reporting, and final validation. Production is not the staging target.

- [ ] **Step 8: Verify every aggregate against the root context**

Run each checker, copied-bundle verifier, secret scan, context/SHA/time validation, and aggregate dry completeness. RC/stable/integrity receipts remain pending and must not be fabricated.

### Task 11: Assemble and review the RC1 approval packet

**Files:**
- Create: `tmp/release-readiness/v0.30.0/v0.30.0-rc.1/README.md`
- Create: `tmp/release-readiness/v0.30.0/v0.30.0-rc.1/manifest.json`
- Create: `tmp/release-readiness/v0.30.0/v0.30.0-rc.1/checksums.json`
- Create: `tmp/release-readiness/v0.30.0/v0.30.0-rc.1/04-rc-plan/deploy-plan.md`
- Create: `tmp/release-readiness/v0.30.0/v0.30.0-rc.1/04-rc-plan/rollback-plan.md`
- Create: `tmp/release-readiness/v0.30.0/v0.30.0-rc.1/04-rc-plan/expected-health.json`
- Create: pending approval markers under `05-approvals/`

**Interfaces:**
- Produces a self-contained, checksum-addressed RC1 decision packet.

- [ ] **Step 1: Generate the release-candidate plan without executing it**

```bash
npm run receipt:release-candidate:plan -- \
  --version v0.30.0-rc.1 \
  --source-version v0.30.0 \
  --repo Mumega-com/mupot \
  --out-dir tmp/release-readiness/v0.30.0/release-candidate
```

- [ ] **Step 2: Build a canonical manifest and checksums**

Sort paths lexically, reject symlinks/extras/secrets, hash bytes with SHA-256, and include the root release context hash.

- [ ] **Step 3: Write the exact authority boundary**

README states no RC tag/prerelease/deployment exists, names exact approvals requested, and says any merge invalidates the packet.

- [ ] **Step 4: Independent packet review**

Run one whole-packet review and Athena Artifact+SHA gate. The verdict may approve preparation only; it cannot authorize tag/deploy.

- [ ] **Step 5: Final completion audit**

Verify every spec completion criterion against current Git, GitHub, Mupot, receipt files, checksums, and runtime evidence. Confirm no tag/release/deployment/migration/credential/ACL action occurred. Mark the goal complete only if every pre-RC requirement is proven and both approval markers remain pending.
