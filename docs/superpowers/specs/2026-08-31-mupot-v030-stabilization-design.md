# Mupot v0.30.0 Stabilization Design

**Status:** Approved in chat on 2026-08-31; written-spec review pending.

**Objective:** Stabilize Mupot v0.30.0 from one immutable `main` SHA, restack and gate PR #1252, reconcile release metadata and release-checking truth, collect every required pre-RC receipt, and prepare the RC1 approval packet without creating a tag, GitHub Release, deployment, production migration, credential change, or ACL change.

## 1. Current truth

The design starts from these measured facts:

- GitHub `main`: `c6ef9876db7575d86de85df378049663d627033b`.
- Main tree: `dad150c2ad7cb06093815e55a46624521035003c`.
- Source version: `0.30.0` in `package.json`, `package-lock.json`, and `src/version.ts`.
- Latest stable tag and GitHub Release: `v0.25.0`.
- Live `/health`: version `0.30.0`, commit `16390d1ea4b9684286237a12443e979e84cb7cdd`, `clean:true`.
- Production is preview and is two first-parent merges behind `main`: #1250 and #1251 are not deployed.
- PR #1251 landed the Mupot/Herdr-neutral Host-Go receipt and copied-bundle fail-closed verification.
- Open PRs #1246, #1247, and #1248 are release-excluded and materially stale; none may enter the frozen candidate without a separately approved roadmap amendment.
- No `v0.30.0` milestone, tag, prerelease, or stable Release exists.
- The full baseline at `c6ef9876` passes 448 files and 6,880 tests.

## 2. Governing principles

### 2.1 One immutable release subject

The release subject is the merge commit of the final metadata/contract PR. Call it `F`.

Every release receipt must either:

1. carry the exact `release_sha: F` and the hash of the release evidence context; or
2. be a GitHub/CI artifact whose subject is independently proven to be `F`.

Any merge after `F` invalidates all candidate evidence, including RC evidence. The process returns to the freeze step with a new SHA.

### 2.2 Evidence is phase-bound

Evidence collected before the freeze cannot satisfy v0.30 readiness merely because it is rechecked later. Native evidence timestamps must be on or after `frozen_at`, must not be implausibly in the future, and must bind to the release context.

### 2.3 Gate independence

Authors and implementers do not self-clear. Each code PR receives:

- task-level spec review;
- task-level quality review;
- cumulative exact-head review;
- Athena exact-head gate;
- direct Hadi approval before merge.

Focused tests never override a failing full suite, required check, CodeQL result, or exact-head gate.

### 2.4 Authority boundary

This flight authorizes branch work, tests, read-only exports, receipt planning, bounded evidence collection required by the approved goal, and preparation of decision packets.

It does not authorize:

- merging a PR without a direct merge instruction naming that PR;
- creating or moving `v0.30.0-rc.1` or `v0.30.0` tags;
- creating a GitHub prerelease or stable Release;
- deploying RC or stable code;
- applying production migrations;
- changing credentials, ACLs, branch protection, or live service state except where a later evidence operation is separately approved;
- global SOS retirement.

## 3. Workstream A: PR #1252 restack and gate

PR #1252 adds exact `codex-cli` harness vocabulary. The typed harness is descriptive client input; bearer-derived agent identity remains authoritative. The PR does not backfill existing presence rows and does not prove runtime identity by itself.

### 3.1 Required changes

Restack the single PR commit onto current `main`, then complete the contract across:

- `src/fleet/presence.ts`: canonical persisted harness vocabulary.
- `src/presence/seven-axis.ts`: canonical parsed harness vocabulary.
- `src/mcp/index.ts`: MCP tool schema accepted-harness text.
- `src/mcp/instructions.ts`: human-facing accepted-harness instructions.
- `tests/seven-axis-presence.test.ts`: real SQLite check-in and exact persistence.
- `tests/mcp-instructions.test.ts`: schema/instruction vocabulary agreement.

### 3.2 Compatibility invariants

- `codex-cli` is accepted exactly.
- `codex`, casing variants, whitespace variants, and unknown strings remain `unknown` unless separately specified.
- `source:'codex'` remains supported and distinct from `harness:'codex-cli'`.
- Seat labels remain sanitized descriptive labels, not identity evidence.
- No current presence row is mutated or backfilled by the PR.

### 3.3 Gate and disposition

The old #1252 checks become historical after restack. The new exact head must pass focused tests, typecheck, full Vitest, composition, recursive fleet tests, router tests, Wrangler dry run, CI, CodeQL, graph review, cumulative review, and Athena.

The gate does not authorize merge. After the gate, Hadi chooses whether #1252 enters v0.30 or remains a reviewed post-v0.30 change. If it enters, every later branch rebases after its merge. If it is deferred, the release contract continues to treat Host-Go signed evidence—not the descriptive harness string—as runtime proof.

## 4. Workstream B: release authorization correctness

### 4.1 P0 #1080 active-principal hotfix

The verdict write path currently checks only `gate_grants`. A paused agent with a live bound token and surviving grant can still verdict, including through `gate:agent-self-completion`.

The hotfix must:

- add an exact active-principal lookup for members and agents;
- join ordinary gate authority to principal liveness;
- check liveness before the self-completion special case in REST and MCP paths;
- preserve legacy owner/admin web sessions that have no member/agent row;
- preserve bound-agent precedence over the member envelope;
- use real SQLite schema tests proving no verdict row or task transition occurs on denial.

### 4.2 P0 #1081 action-specific parity

A single `can_verdict` boolean cannot represent actual write authority. The shared authorizer must return action-specific decisions for approve and reject and must own:

- squad floor;
- active principal;
- ordinary active gate grant;
- self-completion exception;
- `gate:loops` approval surface capability;
- self-verdict and explicit owner override;
- project evidence-write fence.

REST, MCP, and dashboard approval projections consume the same decision engine. Dashboard rows expose at least `can_approve`, `can_reject`, and bounded refusal reasons. Batch actions must not advertise an operation the write path will reject.

### 4.3 Local-evidence determinism

The historical #1097 failure is not reproduced on recent main pushes, but no source change fixes its failure mechanism. Before the final freeze, the smoke harness must:

- capture failed URL, status, origin, and resource type;
- keep same-origin 404s and `pageerror` fatal;
- make Google Font loading hermetic or explicitly record its exact hosts as cosmetic/non-fatal;
- use condition-based authenticated-root readiness rather than a fixed one-second delay;
- prevent delayed errors from a previous navigation being attributed to the next route;
- retain a rerunnable local command even if GitHub workflow dispatch remains unchanged.

## 5. Workstream C: release tooling hardening

This work is split into independent, reviewable PRs.

### 5.1 Readiness gate parity and issue scope

The readiness checker must require every current `ci.yml` job:

- `build`
- `plugin`
- `local-evidence`
- `no-secrets`
- `reserved-bindings`
- `test-schema-source`
- `operator-counts-source`
- `migration-numbering`
- `branch-staleness`
- `design-status-policy`

PR evidence also requires aggregate `CodeQL` and the Actions, JavaScript/TypeScript, and Python analyses. Push evidence requires the three analyses without inventing an aggregate check.

Tests parse the workflow job keys and fail if a future job is absent from the constants.

The v0.30 contract gains an `issue_scope` naming the exact v0.30 milestone and requiring zero open milestone issues. When absent, legacy contracts retain their current behavior.

### 5.2 Live deployment, publication, and soak integrity

Stable deployment evidence must require:

- aggregate deployment `status:'pass'`;
- raw `health.json` present, parseable, secret-free, and hashed;
- embedded and raw health agreement for `ok`, `service`, `version`, `commit`, and `clean`;
- `health.clean === true`;
- exact release SHA and version.

Release integrity must export milestones with `state=all`, paginate, and fail on zero or multiple matches.

Production soak becomes release-neutral and requires explicit RC version and frozen SHA across all observations and cycles. The release-candidate receipt is the live smoke gate; soak proves seven daily observations and at least three complete task cycles.

### 5.3 Frozen-SHA and evidence-time binding

Introduce `mupot-release-evidence-context/v1` with:

- `version:'0.30.0'`;
- exact 40-hex `release_sha`;
- `frozen_at`;
- release PR number and merge commit;
- release contract hash.

Context creation refuses a dirty checkout, a non-`origin/main` subject, or caller SHA disagreement.

Fresh-install, Host-Go/bundle, GitHub App, work-lifecycle, external-PR-cycle, and staging-recovery aggregates record the exact context hash, release SHA, and native evidence time. Readiness requires exact agreement and post-freeze freshness. Recovery must prove target, deployed, restored, and final-validation SHAs equal `F`. Host-Go freshness is derived from source receipts, not only the final manifest time.

Legacy v0.23 parsing remains isolated and unchanged.

## 6. Workstream D: final release metadata and contract

The final metadata PR lands after every code/tooling PR. It changes only release truth and contract activation.

It must:

- correct README current-version prose;
- record #1250, #1251, and the explicit #1252 disposition;
- mark prior metadata preparation complete;
- correct ROADMAP release order and current state;
- update `docs/releases/v0.30.0.md` commands to the actual audit and recursive fleet commands;
- activate release evidence context, issue scope, soak, raw-health, clean-status, and SHA/time requirements in `v0.30.0-contract.json`;
- create the external `v0.30.0 - Stabilized Control Plane` milestone without repurposing an unrelated milestone;
- record release-excluded #1246, #1247, and #1248 with branches preserved;
- keep tag, release, deployment, stable milestone closure, and publication claims pending.

The merge commit of this PR is `F`. The final PR body and merge receipt name `F`, its tree, all required checks, CodeQL, and Athena verdict.

## 7. Freeze and pre-RC evidence flight

After the final metadata merge:

1. Fetch and verify `origin/main === F`.
2. Create a clean isolated checkout at `F`.
3. Record the release context and source metadata hashes.
4. Verify every PR and push check on the exact subject.
5. Run typecheck, full Vitest, composition, recursive fleet, router, audit, audit-gate, complete migrations, schema-source, Wrangler dry run, and local browser/runtime/routine evidence.
6. Collect fresh-install evidence on an approved throwaway Cloudflare target.
7. Export and check GitHub App permissions without repairing them silently.
8. Collect the signed Host-Go source bundle, neutral cutover gate, portable export, and copied-manifest check.
9. Collect a real work lifecycle.
10. Collect a real external task-to-issue-to-PR cycle.
11. Run staging backup, upgrade, restore, rollback, Queue/DLQ, failure-reporting, and final-validation rehearsal against `F`.
12. Assemble the aggregate directory and run a pre-RC completeness audit.

If any evidence operation would require credential repair, permission repair, a production mutation, or a new external authority, stop and request that authority. Do not convert missing authority into a fabricated manual receipt.

## 8. RC1 preparation boundary

Prepare this packet without creating or deploying RC1:

```text
v0.30.0-rc.1/
  00-freeze/
  01-ci/
  02-objectives/
    fresh-install/
    host-go/
    github-app/
    work-lifecycle/
    external-pr-cycle/
    staging-recovery/
  03-aggregate/
  04-rc-plan/
  05-approvals/
    rc-tag-approval.pending
    rc-deploy-approval.pending
  manifest.json
  checksums.json
  README.md
```

The packet states:

- frozen SHA and tree;
- no RC tag, prerelease, or deployment exists;
- exact tag/deploy approvals requested;
- expected health document and rollback plan;
- any merge invalidates the packet.

Release-candidate, stable-deployment, prepublication, release-integrity, and final-readiness receipts remain pending when the objective ends. They cannot truthfully pass before the separately approved publication/deployment phases.

## 9. Completion criteria

The stabilization objective is complete only when:

- #1252 is restacked, completed, and independently gated, with an explicit merge/defer disposition;
- #1080 and #1081 are fixed and gated;
- local-evidence determinism is hardened and gated;
- release readiness, live evidence, soak, and freeze binding are fixed and gated;
- final release metadata is merged with direct approval;
- its merge commit is frozen as `F` and no later merge exists;
- every pre-RC receipt required by the approved v0.30 contract is fresh, passing, and bound to `F`;
- the RC1 packet is complete, hashed, and independently reviewed;
- no RC/stable tag, GitHub Release, deployment, production migration, credential change, or ACL change occurred without separate approval.

Any missing, stale, unbound, manually fabricated, or indirectly inferred evidence leaves the objective incomplete.
