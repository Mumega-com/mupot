# Credential Rotation Boundary Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add atomic member-token rotation that cannot be used for cross-member, cross-squad, or cross-tenant credential takeover.

**Architecture:** Resolve org authority from the authenticated `AuthContext` before looking up the target token. Hash a newly generated token locally, then execute an append-only unique rotation claim, compare-and-set revocation, and claim-gated replacement insert in one D1 batch; return raw material only after all statements succeed.

**Tech Stack:** TypeScript, Cloudflare D1 batch API, Web Crypto, Hono MCP tools, Vitest with real SQLite migrations.

**Spec:** `docs/superpowers/specs/2026-08-29-pr1236-fix-forward-design.md`

## Global Constraints

- Start from the merged CI-foundation descendant on refreshed `origin/main` after Loom Slice 2 GO.
- Do not accept caller-supplied rotating member, tenant, principal, role, or owner fields.
- A squad-scoped admin grant is insufficient; require server-derived org owner/admin authority.
- Check authorization before token lookup and return the same refusal for existing and nonexistent token IDs.
- Never log or persist the raw replacement token; no live token is rotated in this slice.
- Design-time migration path is `migrations/0133_token_rotations.sql`; renumber above then-current main before editing.

---

### Task 1: Add an Append-Only Rotation Claim

**Files:**
- Create: `migrations/0133_token_rotations.sql` (renumber above current head at execution)
- Test: `tests/token-rotations-migration.test.ts`

**Interfaces:**
- Produces: `token_rotations` with one row per original token and immutable, non-secret evidence.

- [ ] **Step 1: Write migration invariants**

Using the canonical migration harness, assert one original token cannot be claimed twice, request IDs are tenant-unique, digests are lowercase 64-hex, and update/delete attempts fail.

- [ ] **Step 2: Confirm RED and create the table**

Required fields are `id`, `tenant`, `original_token_id`, `replacement_token_id`, `rotated_by_member_id`, `credential_id`, `request_id`, `replacement_hash_digest`, and `rotated_at`. Add `UNIQUE (tenant, original_token_id)`, `UNIQUE (tenant, request_id)`, and no-update/no-delete triggers. Store only a digest of the stored replacement hash, never raw replacement material.

- [ ] **Step 3: Verify and commit**

```bash
npx vitest run tests/token-rotations-migration.test.ts tests/helpers-migrations.test.ts
node scripts/check-migration-numbering.mjs origin/main
git add migrations tests/token-rotations-migration.test.ts
git commit -m "feat(db): add token rotation claims"
```

### Task 2: Specify the Authorization and Atomicity Predicate

**Files:**
- Create: `tests/token-rotation-boundary.test.ts`
- Read: `src/types.ts`
- Read: `src/mcp/index.ts`
- Read: `migrations/0002_members.sql`
- Read: `migrations/0043_member_tokens_tenant.sql`
- Read: `migrations/0099_member_token_lifecycle.sql`
- Read: `migrations/0125_mutation_host_control_audit.sql`

**Interfaces:**
- Consumes: `AuthContext.tokenId`, `AuthContext.memberId`, `AuthContext.role`, and org-scoped capabilities.
- Produces: failing cases for scope-only admin, another tenant, another member, nonexistent-token oracle, concurrent rotation, insert failure, revocation failure, and audit failure.

- [ ] **Step 1: Build the real SQLite fixture**

```ts
const harness = createSqliteD1()
applyAllMigrations(harness.sqlite)
const env = { DB: harness.d1, TENANT_SLUG: 'tenant-a' } as Env
```

Seed two tenants, two members, their tokens, a squad-admin-only capability, and an org-admin capability.

- [ ] **Step 2: Write the adversarial tests**

Assert `403 forbidden` occurs before any token-ID-dependent detail for non-org callers. Run two rotations against one original token and assert exactly one succeeds, one replacement row remains live, the original is revoked once, and exactly one audit row exists. Inject a failing batch statement and assert no replacement, revocation, or audit row lands.

- [ ] **Step 3: Confirm RED**

Run: `npx vitest run tests/token-rotation-boundary.test.ts`

Expected: failure because the service and MCP tool do not exist.

### Task 3: Implement the Rotation Service

**Files:**
- Modify: `src/auth/token-lifecycle.ts`
- Modify: `src/lib/crypto.ts`
- Test: `tests/token-rotation-boundary.test.ts`

**Interfaces:**
- Consumes: `RotateMemberTokenInput { tokenId: string; requestId: string; label?: string }`, authenticated `AuthContext`, and `Env.DB`.
- Produces: `rotateMemberToken(env, auth, input): Promise<{ tokenId: string; token: string; expiresAt: string | null } | RotationFailure>`.

- [ ] **Step 1: Define the server-owned input/output**

```ts
export interface RotateMemberTokenInput {
  tokenId: string
  requestId: string
  label?: string
}

export type RotationFailure = {
  ok: false
  status: 400 | 403 | 404 | 409 | 500
  error: 'invalid_args' | 'forbidden' | 'not_found' | 'already_rotated' | 'rotation_failed'
}
```

The service receives `auth` separately; the input has no identity field.

- [ ] **Step 2: Implement pre-lookup org authorization**

Use `auth.role === 'owner' || auth.role === 'admin'` or the repository's exact org-scoped capability helper. Do this before the first query mentioning `input.tokenId`.

- [ ] **Step 3: Implement one atomic batch**

Generate 32 random bytes, encode once, SHA-256 hash for storage, and create rotation/replacement UUIDs. Batch in this exact order:

```sql
INSERT OR IGNORE INTO token_rotations
(id, tenant, original_token_id, replacement_token_id,
 rotated_by_member_id, credential_id, request_id,
 replacement_hash_digest, rotated_at)
SELECT ?, ?, id, ?, ?, ?, ?, ?, datetime('now')
FROM member_tokens
WHERE id = ? AND tenant = ? AND revoked_at IS NULL;

UPDATE member_tokens
SET revoked_at = datetime('now')
WHERE id = ? AND tenant = ? AND revoked_at IS NULL
  AND EXISTS (
    SELECT 1 FROM token_rotations
    WHERE tenant = ? AND original_token_id = ? AND request_id = ?
  );

INSERT INTO member_tokens
(id, member_id, token_hash, label, channel, created_at, revoked_at,
 agent_id, tenant, expires_at, last_used_at)
SELECT ?, member_id, ?, COALESCE(?, label), channel, datetime('now'), NULL,
       agent_id, tenant, expires_at, NULL
FROM member_tokens
WHERE id = ? AND tenant = ? AND revoked_at IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM token_rotations
    WHERE tenant = ? AND original_token_id = ?
      AND replacement_token_id = ? AND request_id = ?
  );
```

Reject unless the claim insert, compare-and-set update, and replacement insert each report one change. Because the claim is selected from the live tenant-bound original, nonexistent, cross-tenant, and already-revoked targets create no claim. A losing concurrent batch inserts no claim and every later statement is claim-gated, so it leaves no state. Any statement error rolls back the claim and all later writes. The claim is the append-only audit; it contains no raw token material.

- [ ] **Step 4: Verify PASS and mutation witness**

Run: `npx vitest run tests/token-rotation-boundary.test.ts`

Then temporarily replace the org check with `return true`; the squad-admin and cross-member tests must fail. Restore and rerun.

- [ ] **Step 5: Commit**

```bash
git add src/auth/token-lifecycle.ts src/lib/crypto.ts tests/token-rotation-boundary.test.ts
git commit -m "fix(auth): fence token rotation"
```

### Task 4: Expose the Bounded MCP Tool

**Files:**
- Modify: `src/mcp/index.ts`
- Test: `tests/mcp-token-rotation.test.ts`

**Interfaces:**
- Consumes: `rotateMemberToken(env, auth, { tokenId, requestId, label })`.
- Produces: `token_rotate` with schema containing only `token_id`, `request_id`, and optional `label`.

- [ ] **Step 1: Write schema and authorization tests**

Assert `additionalProperties: false`, no identity/tenant/role input property, member and squad-admin rejection, uniform nonexistent/existing refusal, org-admin success, and no token value in logs/audit rows.

- [ ] **Step 2: Confirm RED**

Run: `npx vitest run tests/mcp-token-rotation.test.ts`

- [ ] **Step 3: Wire the tool without duplicating authorization**

```ts
const tokenId = str(args.token_id)
const requestId = str(args.request_id)
if (!tokenId || !requestId) return fail(400, 'invalid_args')
return mapRotationOutcome(await rotateMemberToken(env, auth, { tokenId, requestId, label: str(args.label) ?? undefined }))
```

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run tests/mcp-token-rotation.test.ts tests/token-rotation-boundary.test.ts
git add src/mcp/index.ts tests/mcp-token-rotation.test.ts
git commit -m "feat(mcp): expose atomic token rotation"
```

### Task 5: Exact-Head Gate

**Files:**
- Create: `docs/receipts/pr1236-fix-forward/credential-rotation-exact-head.md`

**Interfaces:**
- Consumes: focused tests and the global full-gate commands.
- Produces: exact-head receipt without raw token material.

- [ ] **Step 1: Run focused and full verification**

```bash
npx vitest run tests/token-rotations-migration.test.ts tests/token-rotation-boundary.test.ts tests/mcp-token-rotation.test.ts
npm run typecheck
npm test
node scripts/no-secrets.mjs
node scripts/check-test-schema-source.mjs
node scripts/check-migration-numbering.mjs origin/main
bash scripts/ci-local-evidence.sh
git diff --check origin/main...HEAD
```

- [ ] **Step 2: Open the draft PR and gate it**

Commit the receipt, push, open a draft PR, wait for required checks, obtain Lumen review, rerun after fixes, request Athena exact-head Artifact+SHA256, ask Loom to compose, and stop for Hadi.
