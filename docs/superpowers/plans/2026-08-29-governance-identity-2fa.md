# Governance Identity and 2FA Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive governance identity and founder authority from authenticated server state and require cryptographically verified, replay-safe approval consumption for consequential actions.

**Architecture:** Add one append-safe migration for pre-registered approval keys, approval challenges/receipts, and governance proposals/votes. Canonical identity resolution joins authenticated member/agent bindings and explicit governance capabilities; Ed25519 verification uses an active key already bound to that canonical principal, and decision/receipt plus action consumption are atomic D1 transitions.

**Tech Stack:** TypeScript, Web Crypto Ed25519, canonical JSON/SHA-256, D1/SQLite, MCP, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-29-pr1236-fix-forward-design.md`

## Global Constraints

- Start from the merged credential-rotation descendant after Loom Slice 3 GO.
- Design-time migration path is `migrations/0134_governance_approvals.sql`; before editing, rename it above the then-current live migration head and record the chosen number.
- Never accept `voter_seat`, `voter_type`, `founder`, approving principal, key owner, or verification outcome from the caller.
- Do not treat signature presence as verification. This slice exposes no public approval-key registration tool; live key enrollment is a separately authorized operation outside this goal.
- Token rotation must consume a matching approval in the same consequential mutation once enforcement is wired.

---

### Task 1: Add Durable Approval and Governance Tables

**Files:**
- Create: `migrations/0134_governance_approvals.sql` (renumber above current head at execution)
- Test: `tests/governance-approvals-migration.test.ts`

**Interfaces:**
- Produces: `approval_keys`, `approval_challenges`, `approval_receipts`, `governance_proposals`, and `governance_votes` with tenant-scoped unique keys and append-only receipts/votes.

- [ ] **Step 1: Write migration-shape and invariant tests**

Use `createSqliteD1()` plus `applyAllMigrations()`. Assert duplicate active key fingerprint, duplicate challenge nonce, duplicate principal vote, receipt update/delete, expired challenge consumption, and a second challenge consumption fail at SQLite level.

- [ ] **Step 2: Confirm RED**

Run: `npx vitest run tests/governance-approvals-migration.test.ts`

- [ ] **Step 3: Create the tables**

`approval_keys` stores tenant, principal kind/id, Ed25519 public JWK coordinate, fingerprint, enrolled/revoked timestamps, and enrolling receipt ID. Required keys elsewhere include `(tenant, challenge_id)`, `(tenant, proposal_id, principal_kind, principal_id)`, `action_hash`, `target_kind`, `target_id`, `expires_at`, `decided_at`, `consumed_at`, `key_fingerprint`, and `signature_digest`. Add no-update/no-delete triggers for receipts and votes and disallow changing a key's ownership/fingerprint.

- [ ] **Step 4: Verify numbering, migration chain, and commit**

```bash
npx vitest run tests/governance-approvals-migration.test.ts tests/helpers-migrations.test.ts
node scripts/check-migration-numbering.mjs origin/main
git add migrations tests/governance-approvals-migration.test.ts
git commit -m "feat(db): add governed approval records"
```

### Task 2: Implement Canonical Principal and Vote Resolution

**Files:**
- Create: `src/governance/service.ts`
- Modify: `src/auth/capability.ts`
- Test: `tests/governance-identity.test.ts`

**Interfaces:**
- Consumes: `AuthContext`, `agent_member_bindings`, active agents/members, and explicit governance capability records.
- Produces: `resolveGovernancePrincipal(env, auth): Promise<GovernancePrincipal | null>` and `voteGovernance(env, principal, input)`.

- [ ] **Step 1: Define the server-owned identity**

```ts
export interface GovernancePrincipal {
  tenant: string
  principalKind: 'member' | 'agent'
  principalId: string
  memberId: string
  agentId: string | null
  canonicalSeat: string | null
  isFounder: boolean
}
```

`isFounder` comes only from an owner/founder org grant. `canonicalSeat` comes only from the active bound agent row.

- [ ] **Step 2: Write adversarial identity tests**

Cover forged `river`, `athena`, and `kayhermes` strings; suspended agent/member; unbound token; duplicate vote through two channels; squad admin without governance capability; and owner/founder grant success.

- [ ] **Step 3: Confirm RED, implement, and mutation-check**

Run: `npx vitest run tests/governance-identity.test.ts`. Implement the joins and unique canonical-principal vote. Temporarily source `canonicalSeat` from input; forged-seat tests must fail. Restore.

- [ ] **Step 4: Commit**

```bash
git add src/governance/service.ts src/auth/capability.ts tests/governance-identity.test.ts
git commit -m "fix(governance): derive voter identity"
```

### Task 3: Implement Cryptographic Approval Verification

**Files:**
- Create: `src/auth/approvals-2fa.ts`
- Modify: `src/lib/crypto.ts`
- Test: `tests/approval-verification.test.ts`

**Interfaces:**
- Consumes: `CreateApprovalChallengeInput { action: string; targetKind: string; targetId: string; payload: unknown; ttlSeconds: number }` and `DecideApprovalChallengeInput { challengeId: string; signature: string }`.
- Produces: `canonicalActionPayload`, `computeActionPayloadHash`, `createApprovalChallenge`, `decideApprovalChallenge`, and `consumeApproval`.

- [ ] **Step 1: Pin canonicalization and signature vectors**

Write tests proving object-key order does not change the hash, array order does, wrong action/target/principal/key fails, expired and replayed signatures fail, and a valid Ed25519 vector succeeds. Use test-generated keys, never committed private material.

- [ ] **Step 2: Confirm RED**

Run: `npx vitest run tests/approval-verification.test.ts`

- [ ] **Step 3: Implement canonical hashing and verification**

```ts
const bytes = new TextEncoder().encode(stableJson({ action, targetKind, targetId, payload }))
const digest = await crypto.subtle.digest('SHA-256', bytes)
const verified = await crypto.subtle.verify({ name: 'Ed25519' }, publicKey, signature, bytes)
```

Load only an active `approval_keys` row whose tenant and canonical principal kind/id match the authenticated principal. Store the public-key fingerprint and signature digest, never unchecked labels.

- [ ] **Step 4: Make decision plus receipt atomic**

Use a conditional challenge update and receipt insert in one batch. Require exactly one updated challenge; duplicate/replay paths return `409` without a second receipt.

- [ ] **Step 5: Mutation-check and commit**

Temporarily replace `verified` with `true`; wrong-key and wrong-payload tests must fail. Restore, rerun, then commit.

```bash
git add src/auth/approvals-2fa.ts src/lib/crypto.ts tests/approval-verification.test.ts
git commit -m "feat(auth): verify action approvals"
```

### Task 4: Wire MCP Tools and Enforce Rotation Consumption

**Files:**
- Modify: `src/mcp/index.ts`
- Modify: `src/auth/token-lifecycle.ts`
- Test: `tests/mcp-governance-approvals.test.ts`
- Test: `tests/token-rotation-2fa.test.ts`

**Interfaces:**
- Consumes: canonical principal resolution and verified approval receipt ID.
- Produces: approval create/verify/status tools; governance propose/vote/status/ratify tools; `token_rotate` requiring `approval_receipt_id` consumed atomically with rotation.

- [ ] **Step 1: Write tool-schema and enforcement tests**

Assert no voter/founder/key-owner fields exist, `additionalProperties: false`, and rotation rejects missing, wrong-action, wrong-target, wrong-principal, expired, and reused receipts.

- [ ] **Step 2: Confirm RED and wire tools**

Run: `npx vitest run tests/mcp-governance-approvals.test.ts tests/token-rotation-2fa.test.ts`.

Map authenticated context to the services; do not duplicate identity decisions in MCP argument parsing.

- [ ] **Step 3: Couple approval consumption to rotation**

Add the conditional approval-consume statement to the same rotation batch. A successful standalone consume endpoint cannot authorize a later rotation; the consequential action owns consumption.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run tests/mcp-governance-approvals.test.ts tests/token-rotation-2fa.test.ts tests/token-rotation-boundary.test.ts
git add src/mcp/index.ts src/auth/token-lifecycle.ts tests/mcp-governance-approvals.test.ts tests/token-rotation-2fa.test.ts
git commit -m "fix(auth): enforce governed token rotation"
```

### Task 5: Exact-Head Gate

**Files:**
- Create: `docs/receipts/pr1236-fix-forward/governance-identity-2fa-exact-head.md`

**Interfaces:**
- Produces: migration, signature-vector, adversarial identity, full-suite, Lumen, Athena, and Loom evidence.

- [ ] **Step 1: Run focused, migration, and full gates**

```bash
npx vitest run tests/governance-approvals-migration.test.ts tests/governance-identity.test.ts tests/approval-verification.test.ts tests/mcp-governance-approvals.test.ts tests/token-rotation-2fa.test.ts
npm run typecheck
npm test
node scripts/no-secrets.mjs
node scripts/check-test-schema-source.mjs
node scripts/check-migration-numbering.mjs origin/main
bash scripts/ci-local-evidence.sh
git diff --check origin/main...HEAD
```

- [ ] **Step 2: Gate and stop**

Commit receipt, push, open draft PR, obtain green required checks, Lumen review, Athena exact-head Artifact+SHA256, and Loom composition. Stop for Hadi's merge decision.
